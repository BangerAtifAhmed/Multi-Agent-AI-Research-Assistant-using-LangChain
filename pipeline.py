import re 
from rich import print
from pprint import pprint
from agents import build_search_agent, build_scrape_agent, writter_chain, crictic_chain , pdf_chain , hybrid_chain
import os
import hashlib
from dotenv import load_dotenv
from langchain_chroma import Chroma
from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_huggingface import (
    HuggingFaceEmbeddings,
    HuggingFaceEndpointEmbeddings,
)

load_dotenv()

USE_LOCAL = True

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
    research_combined =(f"Search Results:\n{state['search_results']}\n\nScraped Content:\n{state['scraped_content']}")

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

def get_pdf_hash(pdf_path):
    sha256 = hashlib.sha256()

    with open(pdf_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            sha256.update(chunk)

    return sha256.hexdigest()


def get_embeddings():
    if USE_LOCAL:
        print("Using Local Embedding Model")

        return HuggingFaceEmbeddings(
            model_name=r"C:\OpenSourcesModels\HuggingFace\Embeddings\hub\models--sentence-transformers--all-mpnet-base-v2\snapshots\e8c3b32edf5434bc2275fc9bab85f82640a19130",
            model_kwargs={"device": "cuda"},
        )

    print("Using Hugging Face API")

    return HuggingFaceEndpointEmbeddings(
        model="BAAI/bge-small-en-v1.5",
        huggingfacehub_api_token=os.environ.get("HUGGINGFACEHUB_API_TOKEN"),
    )



def pdf_research_pipeline(pdf_path: str, query: str, embeddings) -> str:



    doc_hash = get_pdf_hash(pdf_path)

    vector_store = Chroma(
        collection_name=doc_hash,
        embedding_function=embeddings,
        persist_directory="./chroma_persist",
    )

    if vector_store._collection.count() == 0:

        print("New PDF")

        loader = PyPDFLoader(
            file_path=pdf_path,
            mode="page",
            pages_delimiter="\n\n",
        )

        docs = loader.load()

        splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=100,
        )

        chunks = splitter.split_documents(docs)

        vector_store.add_documents(chunks)

    else:
        print("Already indexed")

    retriever = vector_store.as_retriever(
        search_type="similarity_score_threshold",
        search_kwargs={
            "score_threshold": 0.1,
            "k": 5,
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
def hybrid_research_pipeline(pdf_path: str, topic: str, embeddings) -> dict:

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
        print("1. 🌐 Web Research")
        print("2. 📄 PDF Research")
        print("3. 🔄 Hybrid Research")
        print("4. ❌ Exit")

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

            print("\n❌ Invalid choice. Please select 1, 2, 3, or 4.")

        input("\nPress Enter to return to the main menu...")