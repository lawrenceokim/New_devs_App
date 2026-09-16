from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Dict, Any
from app.services.cache import get_revenue_summary
from app.core.auth import authenticate_request as get_current_user

router = APIRouter()

@router.get("/dashboard/summary")
async def get_dashboard_summary(
    property_id: str,
    year: int | None = Query(None, ge=1),
    month: int | None = Query(None, ge=1, le=12),
    current_user: dict = Depends(get_current_user)
) -> Dict[str, Any]:
    
    tenant_id = getattr(current_user, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=403, detail="Tenant context required")

    if (year is None) != (month is None):
        raise HTTPException(status_code=400, detail="Both year and month are required for monthly revenue")
    
    revenue_data = await get_revenue_summary(property_id, tenant_id, year, month)
    
    return {
        "tenant_id": revenue_data["tenant_id"],
        "property_id": revenue_data['property_id'],
        "year": revenue_data.get("year"),
        "month": revenue_data.get("month"),
        "total_revenue": revenue_data['total'],
        "currency": revenue_data['currency'],
        "reservations_count": revenue_data['count']
    }
