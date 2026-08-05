import os
import warnings
from rich import print
from pprint import pprint
from dotenv import load_dotenv
from tools import web_search, scrape_url
from langchain.agents import create_agent
from langchain_mistralai import ChatMistralAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

load_dotenv()
warnings.filterwarnings("ignore")

# Model configuration
llm = ChatMistralAI(model_name="mistral-small-2506",api_key = os.getenv("MISTRAL_API_KEY"), temperature=0, max_tokens=2000) 

# 1st Agent for web search
def build_search_agent():
    
    return create_agent(
        model=llm,
        tools=[web_search],
    )

# 2nd Agent for scraping content from a URL
def build_scrape_agent():
    return create_agent(
        model=llm,
        tools=[scrape_url],
    )

# Writter agent to generate a research report based on the gathered information
writer_prompt = ChatPromptTemplate.from_messages([
    ("system", "You are an expert research writer. Write clear, structured and insightful reports."),
    ("human", """Write a detailed research report on the topic below.

Topic: {topic}

Research Gathered:
{research}

Structure the report as:
- Introduction
- Key Findings (minimum 3 well-explained points)
- Conclusion
- Sources (list all URLs found in the research)

Be detailed, factual and professional."""),
])

writter_chain = writer_prompt | llm | StrOutputParser()

#Critical thinking agent to analyze the research and provide insights
critic_prompt = ChatPromptTemplate.from_messages([
     ("system", "You are a sharp and constructive research critic. Be honest and specific."),
    ("human", """Review the research report below and evaluate it strictly.

Report:
{report}

Respond in this exact format:

Score: X/10

Strengths:
- ...
- ...

Areas to Improve:
- ...
- ...

One line verdict:
..."""),
])

crictic_chain = critic_prompt | llm | StrOutputParser()


