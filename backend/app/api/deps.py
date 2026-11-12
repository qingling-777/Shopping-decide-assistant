from typing import AsyncGenerator
from fastapi import Depends
from app.services.ai_service import AIService


async def get_ai_service() -> AIService:
    return AIService()
