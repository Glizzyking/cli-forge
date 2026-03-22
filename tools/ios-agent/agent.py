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
                break

            action    = decision.get("action", "fail")
            obs       = decision.get("observation", "")
            reasoning = decision.get("reasoning", "")

            print_color(f"[observe] {obs}", "white")
            print_color(f"[reason]  {reasoning}", "yellow")
            print_color(f"[action]  {action}", "green")

            self.history.append(decision)

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
                self.controller.tap(decision.get("x", 0), decision.get("y", 0))

            elif action == "swipe":
                self.controller.swipe(
                    decision.get("x", 0),  decision.get("y", 0),
                    decision.get("x2", 0), decision.get("y2", 0),
                )

            elif action == "type":
                self.controller.type_text(decision.get("text", ""))

            elif action == "home":
                self.controller.press_home()

            time.sleep(interval)

        print_color(f"\n[!] Max rounds ({max_rounds}) reached without completion", "yellow")
        self._save_knowledge(app_name, task, self.history)
        self.controller.disconnect()
        return False

    def _save_knowledge(self, app_name, task, history):
        """Save task history as knowledge for future runs."""
        fname = self.knowledge_dir / f"{app_name.lower().replace(' ', '_')}.json"
        existing = []
        if fname.exists():
            try:
                existing = json.loads(fname.read_text())
            except Exception:
                pass

        existing.append({"task": task, "steps": history})
        fname.write_text(json.dumps(existing, indent=2))
        print_color(f"[→] Knowledge saved: {fname}", "blue")
