
import os
import httpx
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")
model = "gemini-3.1-flash-lite"

url = (
    f"https://generativelanguage.googleapis.com/"
    f"v1beta/models/{model}:generateContent"
)

headers = {
    "x-goog-api-key": api_key,
    "Content-Type": "application/json"
}

payload = {
    "contents": [
        {
            "parts": [
                {"text": "Explain Python in three simple sentences."}
            ]
        }
    ]
}

try:
    print("Testing Gemini text generation...")

    response = httpx.post(
        url,
        headers=headers,
        json=payload,
        timeout=60.0
    )

    print("HTTP Status:", response.status_code)
    print("Response:", response.text[:3000])

except Exception as error:
    print("ERROR:", repr(error))
