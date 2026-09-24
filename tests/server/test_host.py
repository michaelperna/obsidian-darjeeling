"""
Tests for server host endpoints and hardware telemetry (S3-W4).
"""

import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from darjeeling_server.host import (
    CpuSampler,
    ThresholdRequest,
    battery_info,
    set_charge_threshold,
    thermal_info,
)


def test_host_status_endpoint(server):
    """
    Host status returns 200 with standard system telemetry sections.
    """
    resp = server.get("/api/host/status")
    assert resp.status_code == 200
    body = resp.json()
    assert "cpu" in body
    assert "thermal" in body
    assert "memory" in body
    assert "pressure" in body
    assert "agents" in body
    # If host has physical battery, verify schema; otherwise battery is None
    bat = body.get("battery")
    if bat is not None:
        assert "present" in bat
        assert "capacityPct" in bat


def test_host_status_and_threshold_without_battery(tmp_path):
    """
    When host has no battery (SYS_POWER empty or absent), battery is None
    and threshold POST returns 501 (PLAN.md:1180).
    """
    empty_power = tmp_path / "empty_power"
    empty_power.mkdir()
    with patch("darjeeling_server.host.SYS_POWER", empty_power):
        assert battery_info() is None

        req = ThresholdRequest(end=80, start=75)
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(set_charge_threshold(req))
        assert exc_info.value.status_code == 501
        assert "not supported" in exc_info.value.detail.lower()


def test_host_threshold_validation(server):
    """Threshold endpoints reject invalid limits with 400."""
    # end below 40
    resp = server.post("/api/host/battery/threshold", {"end": 35, "start": 30})
    assert resp.status_code == 400

    # end above 100
    resp = server.post("/api/host/battery/threshold", {"end": 105})
    assert resp.status_code == 400

    # start >= end
    resp = server.post("/api/host/battery/threshold", {"end": 80, "start": 80})
    assert resp.status_code == 400

    resp = server.post("/api/host/battery/threshold", {"end": 80, "start": 85})
    assert resp.status_code == 400


def test_threshold_direction_ordering_raising(tmp_path):
    """
    When raising end threshold, write end first then start (SRV-19).
    """
    power_dir = tmp_path / "power_supply" / "BAT0"
    power_dir.mkdir(parents=True)
    (power_dir / "type").write_text("Battery\n")
    start_file = power_dir / "charge_control_start_threshold"
    end_file = power_dir / "charge_control_end_threshold"
    start_file.write_text("75\n")
    end_file.write_text("80\n")

    write_history = []

    def mock_write(path_obj: Path, val: str):
        write_history.append((path_obj.name, str(val).strip()))
        path_obj.write_text(str(val))

    with patch("darjeeling_server.host._write_sysfs", side_effect=mock_write), \
         patch("darjeeling_server.host.SYS_POWER", tmp_path / "power_supply"):
        req = ThresholdRequest(end=90, start=85)
        res = asyncio.run(set_charge_threshold(req))
        assert res["status"] == "set"
        # Raising: end (90) must be written before start (85)
        assert write_history == [
            ("charge_control_end_threshold", "90"),
            ("charge_control_start_threshold", "85"),
        ]
        assert end_file.read_text().strip() == "90"
        assert start_file.read_text().strip() == "85"


def test_threshold_direction_ordering_lowering(tmp_path):
    """
    When lowering end threshold, write start first then end (SRV-19).
    """
    power_dir = tmp_path / "power_supply" / "BAT0"
    power_dir.mkdir(parents=True)
    (power_dir / "type").write_text("Battery\n")
    start_file = power_dir / "charge_control_start_threshold"
    end_file = power_dir / "charge_control_end_threshold"
    start_file.write_text("85\n")
    end_file.write_text("90\n")

    write_history = []

    def mock_write(path_obj: Path, val: str):
        write_history.append((path_obj.name, str(val).strip()))
        path_obj.write_text(str(val))

    with patch("darjeeling_server.host._write_sysfs", side_effect=mock_write), \
         patch("darjeeling_server.host.SYS_POWER", tmp_path / "power_supply"):
        req = ThresholdRequest(end=80, start=75)
        res = asyncio.run(set_charge_threshold(req))
        assert res["status"] == "set"
        # Lowering: start (75) must be written before end (80)
        assert write_history == [
            ("charge_control_start_threshold", "75"),
            ("charge_control_end_threshold", "80"),
        ]
        assert start_file.read_text().strip() == "75"
        assert end_file.read_text().strip() == "80"


def test_threshold_rollback_on_failure(tmp_path):
    """
    If the second write fails, roll back the first write (SRV-19).
    """
    power_dir = tmp_path / "power_supply" / "BAT0"
    power_dir.mkdir(parents=True)
    (power_dir / "type").write_text("Battery\n")
    start_file = power_dir / "charge_control_start_threshold"
    end_file = power_dir / "charge_control_end_threshold"
    start_file.write_text("75\n")
    end_file.write_text("80\n")

    def mock_write(path_obj: Path, val: str):
        if path_obj.name == "charge_control_start_threshold":
            raise OSError("Simulated write error on start threshold")
        path_obj.write_text(str(val))

    with patch("darjeeling_server.host._write_sysfs", side_effect=mock_write), \
         patch("darjeeling_server.host.SYS_POWER", tmp_path / "power_supply"):
        req = ThresholdRequest(end=90, start=85)
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(set_charge_threshold(req))
        assert exc_info.value.status_code == 500
        # end threshold was written to 90, but rolled back to 80 on start failure
        assert end_file.read_text().strip() == "80"


def test_thermal_hwmon_amd_k10temp(tmp_path):
    """AMD k10temp sensors report CPU temperature (SRV-37)."""
    hwmon_dir = tmp_path / "hwmon" / "hwmon0"
    hwmon_dir.mkdir(parents=True)
    (hwmon_dir / "name").write_text("k10temp\n")
    (hwmon_dir / "temp1_input").write_text("54300\n")

    with patch("darjeeling_server.host.Path") as mock_path:
        original_path = Path
        def path_dispatcher(*args, **kwargs):
            p = original_path(*args, **kwargs)
            if str(p) == "/sys/class/hwmon":
                return tmp_path / "hwmon"
            if str(p) == "/sys/class/thermal":
                return tmp_path / "thermal"
            return p
        mock_path.side_effect = path_dispatcher
        info = thermal_info()
        assert info["cpuCelsius"] == 54.3


def test_thermal_arm_cpu_thermal_fallback(tmp_path):
    """ARM / Raspberry Pi cpu-thermal zones report CPU temperature (SRV-37)."""
    thermal_dir = tmp_path / "thermal" / "thermal_zone0"
    thermal_dir.mkdir(parents=True)
    (thermal_dir / "type").write_text("cpu-thermal\n")
    (thermal_dir / "temp").write_text("48100\n")

    with patch("darjeeling_server.host.Path") as mock_path:
        original_path = Path
        def path_dispatcher(*args, **kwargs):
            p = original_path(*args, **kwargs)
            if str(p) == "/sys/class/hwmon":
                return tmp_path / "hwmon"
            if str(p) == "/sys/class/thermal":
                return tmp_path / "thermal"
            return p
        mock_path.side_effect = path_dispatcher
        info = thermal_info()
        assert info["cpuCelsius"] == 48.1


def test_cpu_sampler_background_thread():
    """CpuSampler runs background thread and calculates usage."""
    sampler = CpuSampler(sample_interval=0.01)
    sampler.start()
    try:
        # Initial reading may be None or numeric
        _ = sampler.get_usage_pct()
    finally:
        sampler.stop()
