"""Deprecated model probe endpoint (removed in Protocol v2 per SRV-15, DOC-07)."""

from fastapi import APIRouter

router = APIRouter(prefix="/api/agent/probe", tags=["probe"])
