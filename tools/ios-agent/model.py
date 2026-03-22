"""
model.py — Claude Vision AI for iOS Agent
Uses Claude's vision API to analyze screenshots and decide actions
"""

import base64
import json
import os
import requests
from pathlib import Path
from colorama import Fore, Style, init
init(autoreset=True)

API_URL = "https://api.anthropic.com/v1/messages"

SYSTEM_PROMPT = """You are an iOS automation agent. You are given a screenshot of an iPhone screen and a task to complete.

Analyze the screenshot and decide the NEXT SINGLE action to take.

Respond ONLY with valid JSON in this exact format:
{
  "observation": "what you see on screen",
  "reasoning": "why you chose this action",
  "action": "tap|swipe|type|home|done|fail",
  "x": 123,
  "y": 456,
  "x2": 123,
  "y2": 456,
  "text": "text to type if action is type",
  "done": false,
  "message": "final message if done or fail"
}

Action types:
- tap: tap at (x, y)
- swipe: swipe from (x,y) to (x2,y2)
- type: type text into active field
- home: press home button
- done: task completed successfully
- fail: task cannot be completed

The screen is typically 390x844 for iPhone 14/15 (or similar).
Always respond with raw JSON only, no markdown."""


def load_api_key(config):
    key = config.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        # Try project .env
        env_path = Path(__file__).parent.parent.parent / ".env"
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                m = line.strip()
                if m.startswith("ANTHROPIC_API_KEY="):
                    key = m.split("=", 1)[1].strip()
    return key


def analyze_screenshot(screenshot_path, task, history, config):
    """Send screenshot to Claude Vision and get next action."""
    api_key = load_api_key(config)
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set. Add it to .env in project root.")

    model = config.get("CLAUDE_MODEL", "claude-sonnet-4-6")
    max_tokens = int(config.get("MAX_TOKENS", 1024))

    # Encode screenshot
    with open(screenshot_path, "rb") as f:
        img_data = base64.standard_b64encode(f.read()).decode("utf-8")

    # Build history context
    history_text = ""
    if history:
        history_text = "\n\nPrevious actions taken:\n" + "\n".join(
            f"- {h['action']}: {h.get('reasoning', '')}" for h in history[-5:]
        )

    user_content = [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": img_data,
            },
        },
        {
            "type": "text",
            "text": f"Task: {task}{history_text}\n\nWhat is the next action to take?",
        },
    ]

    resp = requests.post(
        API_URL,
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        json={
            "model": model,
            "max_tokens": max_tokens,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_content}],
        },
        timeout=60,
    )

    if not resp.ok:
        raise RuntimeError(f"Claude API {resp.status_code}: {resp.text}")

    raw = resp.json()["content"][0]["text"].strip()

    # Strip markdown fences if present
    raw = raw.strip("`").strip()
    if raw.startswith("json"):
        raw = raw[4:].strip()

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        print(f"{Fore.YELLOW}[!] Could not parse JSON response: {raw[:200]}{Style.RESET_ALL}")
        return {"action": "fail", "message": "Could not parse AI response", "done": True}
