import re
from rich import print
from pprint import pprint
from agents import build_search_agent, build_scrape_agent, writter_chain, crictic_chain , pdf_chain , hybrid_chain

import settings
from vector_store import get_pdf_hash, get_embeddings, get_vector_store, index_pdf

# Kept for backwards compatibility with the original script; the real switch
# now lives in settings.py / backend/.env (USE_LOCAL_EMBEDDINGS).
USE_LOCAL = settings.USE_LOCAL_EMBEDDINGS

def research_pipelinne(topic:str)->dict:
    state = {}
    # Step 1: Writter agent to gather information on the topic using the search agent
    print("\n" + "="*50 + "\n")
    print(f"Search Agent is Working")
    print("\n" + "="*50 + "\n")
    search_agent = build_search_agent()
    search_results = search_agent.invoke({
       "messages": [{"role": "user", "content": f"Find recent, reliable and detailed information about: {topic}"}]
    })

    state['search_results'] = search_results['messages'][-1].content
    print("\n" + "="*50+ "Search Results"+ "=*50" + "\n")
    pprint(state['search_results'])

    #step 2: Scrape the content from the URLs found in the search results using the scrape agent
    print("\n" + "="*50 + "\n")
    print(f"Scrape Agent is Working")
    print("\n" + "="*50 + "\n")
    scrape_agent = build_scrape_agent()
    reader_results = scrape_agent.invoke({
        "messages": [{"role": "user", "content":   f"Based on the following search results about '{topic}', "
            f"pick the most relevant URL and scrape it for deeper content.\n\n"
            f"Search Results:\n{state['search_results'][:800]}"}]
    })
    state['scraped_content'] = reader_results['messages'][-1].content
    print("\n" + "="*50+ "Scraped Content"+ "=*50" + "\n")
    print(state['scraped_content'])

    #step 3: Writter agent to generate a research report based on the gathered information

    print("\n" + "="*50 + "\n")
    print(f"Writter Agent is Working")
    print("\n" + "="*50 + "\n")

    research_combined = (
        f"SEARCH RESULTS : \n {state['search_results']} \n\n"
        f"DETAILED SCRAPED CONTENT : \n {state['scraped_content']}"
    )

    state["report"] = writter_results = writter_chain.invoke({
        "topic": topic,
        "research": research_combined
    })

    print("\n" + "="*50+ "Research Report"+ "=*50" + "\n")
    print(state["report"])

    # critic report
    print("\n" + "="*50 + "\n")
    print(f"Critic Agent is Working")
    print("\n" + "="*50 + "\n")
    critic_results = crictic_chain.invoke({
        "report": state["report"] })

    state["critic_report"] = critic_results
    text = state["critic_report"]
    # Extract the score from the critic report using regex
    match = re.search(r"\*\*Score:\s*([\d.]+)/10\*\*", text)
    if match:
        score = float(match.group(1))
        print(score)
        state["score"] = score
    else:
        print("Score not found in the critic report.")
        state["score"] = None
    print("\n" + "="*50+ "Critic Report"+ "="*50 + "\n")
    print(state["critic_report"])

    return state


def pdf_research_pipeline(pdf_path: str, query: str, embeddings=None) -> str:

    status = index_pdf(pdf_path, embeddings)
    print("New PDF" if status["indexed"] else "Already indexed")

    vector_store = get_vector_store(status["collection"], embeddings)

    retriever = vector_store.as_retriever(
        search_type="similarity",
        search_kwargs={
            "k": settings.RETRIEVAL_K,
        },
    )

    docs = retriever.invoke(query)

    print("\n" + "=" * 50)
    print("Retrieved Documents")
    print("=" * 50)

    for i, doc in enumerate(docs, 1):
        print(f"\nDocument {i}")
        print("Metadata:", doc.metadata)
        print("Content:")
        print(doc.page_content)
    print("=" * 50)

    context = "\n\n".join(
    doc.page_content for doc in docs
    )

    research = pdf_chain.invoke({
    "context": context,
    "question": query
    })

    return research


def hybrid_research_pipeline(pdf_path: str, topic: str, embeddings=None) -> dict:

    # PDF Research
    pdf_research = pdf_research_pipeline(pdf_path, topic, embeddings)

    # Search Agent
    search_agent = build_search_agent()
    search_results = search_agent.invoke({
        "messages": [{
            "role": "user",
            "content": f"Find recent, reliable and detailed information about: {topic}"
        }]
    })

    # Scrape Agent
    scrape_agent = build_scrape_agent()
    reader_results = scrape_agent.invoke({
        "messages": [{
            "role": "user",
            "content":
                f"Based on the following search results about '{topic}', "
                f"pick the most relevant URL and scrape it.\n\n"
                f"Search Results:\n{search_results['messages'][-1].content[:800]}"
        }]
    })

    # Summarize the web research
    web_summary = writter_chain.invoke({
        "topic": topic,
        "research": f"""
Search Results:
{search_results['messages'][-1].content}

Scraped Content:
{reader_results['messages'][-1].content}
"""
    })

    # Combine PDF + Web Summary
    report = hybrid_chain.invoke({
        "topic": topic,
        "pdf_research": pdf_research,
        "web_research": web_summary
    })

    # Critic
    critic_report = crictic_chain.invoke({
        "report": report
    })

    return {
        "report": report,
        "critic_report": critic_report
    }

if __name__ == "__main__":

    while True:

        print("\n" + "=" * 50)
        print("         AI RESEARCH ASSISTANT")
        print("=" * 50)

        print("\nChoose Research Mode:")
        print("1. Web Research")
        print("2. PDF Research")
        print("3. Hybrid Research")
        print("4. Exit")

        choice = input("\nEnter your choice (1/2/3/4): ").strip()

        if choice == "1":

            topic = input("\nEnter the research topic: ")

            final_results = research_pipelinne(topic)

            print("\n" + "=" * 50)
            print("FINAL RESULTS")
            print("=" * 50)

            print(f"\nCritic Score: {final_results['score']}")
            print("\nResearch Report:\n")
            print(final_results["report"])

            print("\n" + "=" * 50)
            print("CRITIC REPORT")
            print("=" * 50 + "\n")

            print(final_results["critic_report"])

        elif choice == "2":

            embeddings = get_embeddings()

            pdf_path = input("\nEnter PDF Path: ")
            query = input("Enter your question: ")

            answer = pdf_research_pipeline(pdf_path, query, embeddings)

            print("\n" + "=" * 50)
            print("PDF RESEARCH")
            print("=" * 50 + "\n")

            print(answer)

        elif choice == "3":

            embeddings = get_embeddings()

            pdf_path = input("\nEnter PDF Path: ")
            topic = input("Enter the research topic: ")

            final_results = hybrid_research_pipeline(
                pdf_path,
                topic,
                embeddings
            )

            print("\n" + "=" * 50)
            print("FINAL RESULTS")
            print("=" * 50)

            print("\nResearch Report:\n")
            print(final_results["report"])

            print("\n" + "=" * 50)
            print("CRITIC REPORT")
            print("=" * 50 + "\n")

            print(final_results["critic_report"])

        elif choice == "4":

            print("\nThank you for using AI Research Assistant. Goodbye!")
            break

        else:

            print("\nInvalid choice. Please select 1, 2, 3, or 4.")

        input("\nPress Enter to return to the main menu...")
