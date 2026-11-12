from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class ProductImportRequest(BaseModel):
    url: str = Field(min_length=10, max_length=2000)


class ProductRecord(BaseModel):
    id: str
    platform: str
    platform_product_id: Optional[str] = None
    source_url: str
    title: str
    price: Optional[str] = None
    currency: str = "CNY"
    image_url: Optional[str] = None
    shop_name: Optional[str] = None
    brand: Optional[str] = None
    description: Optional[str] = None
    data_source: str
    fetched_at: str
    field_status: Dict[str, bool]


class ProductImportResponse(BaseModel):
    status: str
    product: ProductRecord
