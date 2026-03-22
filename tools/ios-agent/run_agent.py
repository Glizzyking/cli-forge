"""
run_agent.py — entry point for iOS Agent
"""

import argparse
import yaml
import sys
from pathlib import Path

def load_config():
    cfg_file = Path(__file__).parent / "config.yaml"
    if not cfg_file.exists():
        return {}
    with open(cfg_file) as f:
        return yaml.safe_load(f) or {}

def main():
    parser = argparse.ArgumentParser(description="iOS Agent — Claude-powered iPhone automation")
    parser.add_argument("--app",    required=True, help="App name (e.g. Instagram, Safari)")
    parser.add_argument("--task",   required=True, help="Task to complete")
    parser.add_argument("--bundle", default=None,  help="App bundle ID")
    parser.add_argument("--udid",   default=None,  help="Device UDID")
    parser.add_argument("--rounds", type=int, default=None, help="Max rounds")
    args = parser.parse_args()

    config = load_config()

    from agent import iOSAgent
    agent = iOSAgent(config)
    success = agent.run(
        app_name  = args.app,
        task      = args.task,
        bundle_id = args.bundle,
        udid      = args.udid,
        max_rounds= args.rounds,
    )
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
