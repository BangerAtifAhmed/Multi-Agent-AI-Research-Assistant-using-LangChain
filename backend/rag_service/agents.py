import warnings

from rich import print
from pprint import pprint
from tools import web_search, scrape_url
from langchain.agents import create_agent
from langchain_mistralai import ChatMistralAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

import settings

warnings.filterwarnings("ignore")

# Model configuration
llm = ChatMistralAI(
    model_name=settings.MISTRAL_MODEL,
    api_key=settings.MISTRAL_API_KEY,
    temperature=settings.LLM_TEMPERATURE,
    max_tokens=settings.LLM_MAX_TOKENS,
    streaming=True,
)

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

pdf_prompt = ChatPromptTemplate.from_messages([
    (
        "system",
        "You are an expert research assistant. Answer only from the provided PDF context."
    ),
    (
        "human",
        """
Context:
{context}

Question:
{question}

Give a detailed answer based only on the PDF.
"""
    ),
])

pdf_chain = pdf_prompt | llm | StrOutputParser()




hybrid_prompt = ChatPromptTemplate.from_template("""
You are an expert AI Research Assistant.

You have two sources of information:

1. PDF Research
- Information retrieved from the uploaded PDF.
- Treat this as the primary source.

2. Web Research
- Recent information collected from trusted web sources.
- Use it to complement, update, or compare with the PDF.

Your task:
- Answer the user's topic comprehensively.
- Start with the information from the PDF.
- Add relevant recent information from the web.
- Clearly mention if the web research introduces newer developments not present in the PDF.
- If the PDF and web research disagree, explain both viewpoints instead of choosing one without justification.
- Do not invent facts that are not supported by either source.

Topic:
{topic}

PDF Research:
{pdf_research}

Web Research:
{web_research}

Generate a well-structured research report with:
1. Introduction
2. Summary of the PDF
3. Recent Web Findings
4. Comparison (if applicable)
5. Key Takeaways
6. Conclusion
""")

hybrid_chain = hybrid_prompt | llm | StrOutputParser()


# ---------------------------------------------------------------------------
# Chat-aware chains
#
# The chains above are unchanged and still drive the original CLI pipelines.
# The ones below add the conversational behaviour the chat application needs:
# prior turns are part of the prompt, and answers are written for a chat UI
# (Markdown, inline citations) instead of a standalone report.
# ---------------------------------------------------------------------------

CITATION_RULES = """Citation rules:
- Cite the numbered sources you were given, inline, like [1] or [2][3].
- Only cite a source number that appears in the context below.
- Never invent a source, a page number or a URL.
- If the context does not answer the question, say so plainly instead of guessing."""

pdf_chat_prompt = ChatPromptTemplate.from_messages([
    (
        "system",
        """You are an expert research assistant answering questions about the user's documents.
Answer using only the retrieved context. Use Markdown: headings, bold, lists, tables and
fenced code blocks where they genuinely help readability.

"""
        + CITATION_RULES,
    ),
    (
        "human",
        """Conversation so far (for pronouns and follow-up context only):
{history}

Retrieved context:
{context}

Question:
{question}

Answer the question from the retrieved context.""",
    ),
])

pdf_chat_chain = pdf_chat_prompt | llm | StrOutputParser()


web_chat_prompt = ChatPromptTemplate.from_messages([
    (
        "system",
        """You are an expert AI research assistant answering from live web research.
Write a clear, well-structured Markdown answer. Lead with the direct answer, then
supporting detail. Use headings and lists only when they aid readability.

Every figure, date and name must come from the web research below, not from
memory - the search results are more current than your training data, so where
they disagree the search results are right. Cite the source for each figure. If
the research does not contain the answer, say so instead of supplying a
remembered value. When the research reports a figure as of a particular date,
give that date alongside it.

"""
        + CITATION_RULES,
    ),
    (
        "human",
        """Conversation so far (for pronouns and follow-up context only):
{history}

Web research:
{research}

Question:
{question}

Answer the question from the web research.""",
    ),
])

web_chat_chain = web_chat_prompt | llm | StrOutputParser()


hybrid_chat_prompt = ChatPromptTemplate.from_messages([
    (
        "system",
        """You are an expert AI research assistant with two sources of information:
the user's documents and live web research.

- Lead with whichever source actually answers the question.
- For anything time-sensitive - prices, box office and other running totals,
  news, scores, current events - the web research is authoritative. Take those
  figures from it, never from memory.
- If the documents are not about the subject of the question, ignore them
  rather than describing what they do not contain.
- Add recent web findings and call out anything newer than the documents.
- If the two disagree, present both viewpoints instead of silently picking one.
- Never invent facts that neither source supports.

Write the answer in Markdown.

"""
        + CITATION_RULES,
    ),
    (
        "human",
        """Conversation so far (for pronouns and follow-up context only):
{history}

Document research:
{pdf_research}

Web research:
{web_research}

Question:
{question}

Answer the question using both sources.""",
    ),
])

hybrid_chat_chain = hybrid_chat_prompt | llm | StrOutputParser()


# Plain assistant: used when the router decides no retrieval is needed
# (general knowledge, reasoning, writing, coding). No context is injected, so
# the model must not pretend to cite sources it was not given.
general_chat_prompt = ChatPromptTemplate.from_messages([
    (
        "system",
        """You are a knowledgeable, helpful assistant. Answer directly and accurately.

Use Markdown: headings, bold, lists, tables and fenced code blocks where they
genuinely help readability.

You have not been given any documents or search results for this question, so do
not cite sources or invent references. If the answer depends on very recent
events you may not know about, say so plainly.""",
    ),
    (
        "human",
        """Conversation so far (for pronouns and follow-up context only):
{history}

Question:
{question}""",
    ),
])

general_chat_chain = general_chat_prompt | llm | StrOutputParser()


# Query rewriting: turns a follow-up like "why is it useful?" into a
# self-contained query so vector search and web search actually work.
condense_prompt = ChatPromptTemplate.from_messages([
    (
        "system",
        "You rewrite follow-up questions into standalone search queries.",
    ),
    (
        "human",
        """Conversation so far:
{history}

Follow-up question:
{question}

Rewrite the follow-up question as a single standalone search query that makes sense
without the conversation. Resolve pronouns and implicit references. Keep it under 30 words.
If the question already stands alone, return it unchanged.
Return only the rewritten query, with no preamble and no quotes.""",
    ),
])

condense_chain = condense_prompt | llm | StrOutputParser()
