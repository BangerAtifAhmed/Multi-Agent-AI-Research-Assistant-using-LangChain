import re
import requests
from rich import print
from pprint import pprint
from bs4 import BeautifulSoup
from langchain.tools import tool
from langchain_tavily import TavilySearch
from langchain_community.document_loaders import PyPDFLoader

import settings

TAVILY_API_KEY = settings.TAVILY_API_KEY


tavily = TavilySearch(api_key=TAVILY_API_KEY)

def tavily_search_raw(query: str, max_results: int = 5) -> list[dict]:
    """Run a Tavily search and return the raw structured results.

    Used by the chat pipeline so real titles/URLs/scores can be surfaced as
    source cards. Returns [] on failure rather than raising, so a search
    outage degrades the answer instead of killing the stream.
    """
    try:
        response = tavily.invoke({"query": query})
        return (response or {}).get("results", [])[:max_results]
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller as "no sources"
        print(f"[tavily_search_raw] {exc}")
        return []


@tool
def web_search(query : str)-> str:
    """Search the web for recent and relable information on a topic.Resturns Titles ,Urls and snipptes"""
    try:
        response = tavily.invoke({"query" : query})
        res_list = []
        for dic in  response['results']:
            res_list.append(f"""
            Title : {dic['title']}
            URL : {dic['url']}
            Content : {dic['content'][:500]}
            """)
        return "\n---\n".join(res_list)
    except Exception as e:
        return f"Error searching the web: {str(e)}"

MAX_SCRAPE_CHARS = 8000

def scrape_text(url: str, max_chars: int = MAX_SCRAPE_CHARS) -> str:
    """Plain-function version of the scraper, callable outside an agent loop."""
    response = requests.get(
        url,
        timeout=10,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        },
    )
    soup = BeautifulSoup(response.text, "html.parser")

    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    text = soup.get_text(separator=" ", strip=True)
    text = re.sub(r"\s+", " ", text).strip()

    if len(text) > max_chars:
        text = text[:max_chars] + "... [truncated]"

    return text


@tool
def scrape_url(url:str)-> str:
    """Scrape and return clean text content from a given URL for deep reading"""
    try:
        return scrape_text(url)
    except Exception as e:
        return f"Error scraping URL: {str(e)}"
