import os
import requests
from rich import print
from pprint import pprint
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from langchain.tools import tool
from langchain_tavily import TavilySearch
load_dotenv()

TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")



tavily = TavilySearch(api_key=TAVILY_API_KEY)

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

@tool
def scrape_url(url:str)-> str:
    """Scrape and return clean text content from a given URL for deep reading"""
    try:
        response = requests.get(url,timeout=10,headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"  })
        soup = BeautifulSoup(response.text, 'html.parser')
        text = soup.get_text()
        return text
    except Exception as e:
        return f"Error scraping URL: {str(e)}"
    

    
scrape_url.invoke("https://en.ilsole24ore.com/art/india-clashes-in-new-delhi-as-thousands-of-students-march-on-parliament-AJZuy2P")