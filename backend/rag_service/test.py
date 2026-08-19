import os
import hashlib
from rich import print
from dotenv import load_dotenv
from langchain_chroma import Chroma

from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_huggingface import HuggingFaceEndpointEmbeddings,HuggingFaceEmbeddings


retriever = vector_store.as_retriever()

print(type(retriever))
print(dir(retriever))
print(retriever.model_fields)