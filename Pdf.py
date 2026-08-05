import os
import hashlib
from rich import print
from dotenv import load_dotenv
from langchain_chroma import Chroma
from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_huggingface import HuggingFaceEndpointEmbeddings,HuggingFaceEmbeddings


pdf_path = r"D:\multi agent system\GRU.pdf"

def get_pdf_hash(pdf_path):
    sha256 = hashlib.sha256()

    with open(pdf_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            sha256.update(chunk)

    return sha256.hexdigest()



load_dotenv()

USE_LOCAL = True

if USE_LOCAL:
    print("Using Local Embedding Model")

    embeddings = HuggingFaceEmbeddings(
        model_name=r"C:\OpenSourcesModels\HuggingFace\Embeddings\hub\models--sentence-transformers--all-mpnet-base-v2\snapshots\e8c3b32edf5434bc2275fc9bab85f82640a19130",
        model_kwargs={
            "device": "cuda"
        }
    )

else:
    print("Using Hugging Face API")

    embeddings = HuggingFaceEndpointEmbeddings(
        model="BAAI/bge-small-en-v1.5",
        huggingfacehub_api_token=os.environ.get("HUGGINGFACEHUB_API_TOKEN")
    )

doc_hash = get_pdf_hash(pdf_path)

vector_store = Chroma(
    collection_name=doc_hash,
    embedding_function=embeddings,
    persist_directory="./chroma_persist"
)

if vector_store._collection.count() == 0:
    print("New PDF")



    loader = PyPDFLoader(
        file_path=pdf_path,
        mode="page",
        pages_delimiter="\n\n"
    )

    docs = loader.load()

    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=100
    )

    chunks = text_splitter.split_documents(docs)

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

query = "What is GRU?"

docs = retriever.invoke(query)

print(f"Retrieved {len(docs)} documents")

for i, doc in enumerate(docs, 1):
    print(f"\n========== Document {i} ==========")
    print(doc.metadata)
    print(doc.page_content[:500])