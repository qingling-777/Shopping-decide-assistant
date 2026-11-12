import httpx
from typing import List, Dict
from app.core.config import settings


class SearchService:
    """联网搜索服务 - 使用 Serper API"""
    
    def __init__(self):
        self.api_key = settings.SERPER_API_KEY
        self.enabled = settings.ENABLE_SEARCH and self.api_key != "your-serper-api-key-here"
    
    async def search(self, query: str, max_results: int = 5) -> List[Dict]:
        """搜索网络信息"""
        if not self.enabled:
            print("[SEARCH] Search disabled or API key not configured")
            return []
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    "https://google.serper.dev/search",
                    headers={
                        "X-API-KEY": self.api_key,
                        "Content-Type": "application/json; charset=utf-8"
                    },
                    json={
                        "q": query,
                        "num": max_results,
                        "gl": "cn",
                        "hl": "zh-cn"
                    }
                )
                response.raise_for_status()
                data = response.json()
                
                results = []
                for item in data.get("organic", [])[:max_results]:
                    results.append({
                        "title": item.get("title", ""),
                        "url": item.get("link", ""),
                        "content": item.get("snippet", ""),
                        "score": 1.0
                    })
                
                print(f"[SEARCH] Found {len(results)} results for: {query}")
                return results
        
        except Exception as e:
            print(f"[SEARCH] Search failed: {e}")
            return []
    
    def format_search_results(self, results: List[Dict]) -> str:
        """格式化搜索结果为文本"""
        if not results:
            return ""
        
        formatted = "\n\n【联网搜索结果】\n"
        for i, result in enumerate(results[:3], 1):
            formatted += f"\n{i}. {result['title']}\n"
            formatted += f"   {result['content'][:200]}...\n"
        
        return formatted


search_service = SearchService()
