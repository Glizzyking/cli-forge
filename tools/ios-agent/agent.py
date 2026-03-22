"""
agent.py — iOS Agent core loop
"""

import time
import json
from pathlib import Path
from colorama import Fore, Style, init
init(autoreset=True)

from ios_controller import iOSController
from model import analyze_screenshot


def print_color(msg, color="white"):
    colors = {
        "red": Fore.RED, "green": Fore.GREEN, "yellow": Fore.YELLOW,
        "blue": Fore.BLUE, "cyan": Fore.CYAN, "magenta": Fore.MAGENTA,
        "white": Fore.WHITE,
    }
    print(f"{colors.get(color, Fore.WHITE)}{msg}{Style.RESET_ALL}")


class iOSAgent:
    def __init__(self, config):
        self.config     = config
        self.controller = iOSController(config)
        self.history    = []
        self.knowledge_dir = Path(config.get("KNOWLEDGE_DIR", "./knowledge"))
        self.knowledge_dir.mkdir(exist_ok=True)

    def run(self, app_name, task, bundle_id=None, udid=None, max_rounds=None):
        max_rounds = max_rounds or int(self.config.get("MAX_ROUNDS", 20))
        interval   = float(self.config.get("REQUEST_INTERVAL", 3))

        print_color(f"\n{'='*50}", "cyan")
        print_color(f"  iOS Agent — {app_name}", "cyan")
        print_color(f"  Task: {task}", "cyan")
        print_color(f"{'='*50}\n", "cyan")

        # Connect to device
        try:
            self.controller.connect(udid=udid, bundle_id=bundle_id)
        except Exception as e:
            print_color(f"[✗] Failed to connect: {e}", "red")
            print_color("    Make sure Appium is running: appium", "yellow")
            print_color("    And your iPhone is connected via USB with trust enabled", "yellow")
            return False

        # Main loop
        for round_num in range(1, max_rounds + 1):
            print_color(f"\n[Round {round_num}/{max_rounds}]", "magenta")

            # Screenshot
            screenshot = self.controller.screenshot(f"{app_name.lower()}_round")
            print_color(f"[→] Screenshot: {screenshot}", "blue")

            # AI decision
            print_color("[→] Asking Claude...", "cyan")
            try:
                decision = analyze_screenshot(screenshot, task, self.history, self.config)
            except Exception as e:
                print_color(f"[✗] AI error: {e}", "red")
                self.controller.disconnect()
                return False

            action    = decision.get("action", "fail")
            obs       = decision.get("observation", "")
            reasoning = decision.get("reasoning", "")

            print_color(f"[observe] {obs}", "white")
            print_color(f"[reason]  {reasoning}", "yellow")
            print_color(f"[action]  {action}", "green")

            self.history.append(decision)

            # Stuck loop detection — same observation 3x in a row
            if len(self.history) >= 3:
                last3_obs = [h.get("observation", "") for h in self.history[-3:]]
                if len(set(last3_obs)) == 1 and last3_obs[0]:
                    print_color("[!] Stuck — same screen 3 rounds. Stopping.", "yellow")
                    self.controller.disconnect()
                    return False

            # Execute action
            if action == "done":
                print_color(f"\n[✓] Task complete: {decision.get('message', '')}", "green")
                self._save_knowledge(app_name, task, self.history)
                self.controller.disconnect()
                return True

            elif action == "fail":
                print_color(f"\n[✗] Task failed: {decision.get('message', '')}", "red")
                self.controller.disconnect()
                return False

            elif action == "tap":
                x, y = decision.get("x"), decision.get("y")
                if x is None or y is None:
                    print_color("[!] AI gave tap without coordinates — skipping", "yellow")
                else:
                    x, y = max(0, min(int(x), 1290)), max(0, min(int(y), 2796))
                    self.controller.tap(x, y)

            elif action == "swipe":
                x,  y  = decision.get("x",  0), decision.get("y",  0)
                x2, y2 = decision.get("x2", 0), decision.get("y2", 0)
                x,  y  = max(0, min(int(x),  1290)), max(0, min(int(y),  2796))
                x2, y2 = max(0, min(int(x2), 1290)), max(0, min(int(y2), 2796))
                self.controller.swipe(x, y, x2, y2)

            elif action == "type":
                text = decision.get("text", "")
                if text:
                    self.controller.type_text(text)
                else:
                    print_color("[!] AI gave type with no text — skipping", "yellow")

            elif action == "home":
                self.controller.press_home()

            time.sleep(interval)

        print_color(f"\n[!] Max rounds ({max_rounds}) reached without completion", "yellow")
        self._save_knowledge(app_name, task, self.history)
        self.controller.disconnect()
        return False

    def _save_knowledge(self, app_name, task, history):
        """Save task history as knowledge for future runs (deduplicated by task)."""
        fname = self.knowledge_dir / f"{app_name.lower().replace(' ', '_')}.json"
        existing = []
        if fname.exists():
            try:
                existing = json.loads(fname.read_text())
            except Exception:
                pass

        # Deduplicate: replace existing entry for same task, append if new
        existing = [e for e in existing if e.get("task") != task]
        existing.append({"task": task, "steps": history, "rounds": len(history)})

        # Keep only last 50 tasks to prevent unbounded growth
        if len(existing) > 50:
            existing = existing[-50:]

        fname.write_text(json.dumps(existing, indent=2))
        print_color(f"[→] Knowledge saved: {fname}", "blue")
