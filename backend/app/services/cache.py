import json
import redis.asyncio as redis
from typing import Dict, Any
import os

# Initialize Redis client (typically configured centrally).
redis_client = redis.Redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"))

def build_revenue_cache_key(property_id: str, tenant_id: str, year: int | None = None, month: int | None = None) -> str:
    if year is not None and month is not None:
        return f"revenue:{tenant_id}:{property_id}:{year}:{month:02d}"
    return f"revenue:{tenant_id}:{property_id}:all"


async def get_revenue_summary(
    property_id: str,
    tenant_id: str,
    year: int | None = None,
    month: int | None = None
) -> Dict[str, Any]:
    """
    Fetches revenue summary, utilizing caching to improve performance.
    """
    cache_key = build_revenue_cache_key(property_id, tenant_id, year, month)
    
    # Try to get from cache
    cached = await redis_client.get(cache_key)
    if cached:
        cached_result = json.loads(cached)
        if (
            cached_result.get("tenant_id") == tenant_id
            and cached_result.get("property_id") == property_id
            and cached_result.get("year") == year
            and cached_result.get("month") == month
        ):
            return cached_result

        await redis_client.delete(cache_key)
    
    # Revenue calculation is delegated to the reservation service.
    from app.services.reservations import calculate_monthly_revenue, calculate_total_revenue
    
    # Calculate revenue
    if year is not None and month is not None:
        result = await calculate_monthly_revenue(property_id, tenant_id, year, month)
    else:
        result = await calculate_total_revenue(property_id, tenant_id)
    
    # Cache the result for 5 minutes
    await redis_client.setex(cache_key, 300, json.dumps(result))
    
    return result
