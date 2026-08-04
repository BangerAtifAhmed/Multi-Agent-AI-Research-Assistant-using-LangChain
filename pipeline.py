from agents import build_search_agent, build_scrape_agent, writter_chain, critic_prompt , crictic_chain
from pprint import pprint
import re 
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


if __name__ == "__main__":
    topic = input("Enter the research topic: ")
    final_results = research_pipelinne(topic)
    print("\n" + "="*50 + "\n")
    print(f"Final Results:")
    print("\n" + "="*50 + "\n")
    print("Crictic Score:", final_results["score"])
    print(f"Research Report:")
    print(final_results["report"])
    print("\n" + "="*50 + "\n")
    print(f"Critic Report:")
    print(final_results["critic_report"])