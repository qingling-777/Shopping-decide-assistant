from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.deps import get_quota_subject, require_admin
from app.services.feedback_service import _feedback_service


router = APIRouter(prefix="/feedback", tags=["feedback"])


class FeedbackRequest(BaseModel):
    content: str
    contact: Optional[str] = None  # 选填：联系方式（微信/手机/邮箱），便于管理员回复


@router.post("")
async def submit_feedback(body: FeedbackRequest, subject: str = Depends(get_quota_subject)):
    """用户提交意见反馈（登录用户→user:<id>；匿名→device:<id>，由后端自动解析，不依赖用户填写）。"""
    try:
        return _feedback_service.submit(subject, body.content, body.contact)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.get("/admin/feedbacks")
async def list_feedbacks(status: Optional[str] = None, admin: dict = Depends(require_admin)):
    """管理员查看用户反馈（可按 status 过滤 pending|handled）。"""
    return {"items": _feedback_service.list(status)}


@router.post("/admin/feedbacks/{feedback_id}/handle")
async def handle_feedback(feedback_id: str, admin: dict = Depends(require_admin)):
    """管理员标记反馈为已处理。"""
    try:
        return _feedback_service.mark_handled(feedback_id, admin["id"])
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
