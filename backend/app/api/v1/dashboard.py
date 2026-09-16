from fastapi import APIRouter, Depends, HTTPException, Query
from decimal import Decimal, ROUND_HALF_UP
from typing import Dict, Any
from app.services.cache import get_revenue_summary
from app.core.auth import authenticate_request as get_current_user

router = APIRouter()

PERCENT = Decimal("0.01")


def get_previous_month(year: int, month: int) -> tuple[int, int]:
    if month == 1:
        return year - 1, 12
    return year, month - 1


def calculate_revenue_change_percent(current_total: str, previous_total: str) -> str:
    current = Decimal(str(current_total))
    previous = Decimal(str(previous_total))

    if previous == 0:
        if current == 0:
            return "0.00"
        return "100.00" if current > 0 else "-100.00"

    change = ((current - previous) / abs(previous)) * Decimal("100")
    return str(change.quantize(PERCENT, rounding=ROUND_HALF_UP))


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
    previous_revenue_data = None
    revenue_change_percent = None

    if year is not None and month is not None:
        previous_year, previous_month = get_previous_month(year, month)
        previous_revenue_data = await get_revenue_summary(property_id, tenant_id, previous_year, previous_month)
        revenue_change_percent = calculate_revenue_change_percent(
            revenue_data["total"],
            previous_revenue_data["total"]
        )
    
    return {
        "tenant_id": revenue_data["tenant_id"],
        "property_id": revenue_data['property_id'],
        "year": revenue_data.get("year"),
        "month": revenue_data.get("month"),
        "previous_year": previous_revenue_data.get("year") if previous_revenue_data else None,
        "previous_month": previous_revenue_data.get("month") if previous_revenue_data else None,
        "previous_month_revenue": previous_revenue_data.get("total") if previous_revenue_data else None,
        "revenue_change_percent": revenue_change_percent,
        "total_revenue": revenue_data['total'],
        "currency": revenue_data['currency'],
        "reservations_count": revenue_data['count']
    }
