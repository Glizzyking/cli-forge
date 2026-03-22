"""
ios_controller.py — iPhone device controller
Uses pymobiledevice3 for device detection + Appium/WebDriverAgent for control
"""

import subprocess
import base64
import time
import os
from pathlib import Path

try:
    from appium import webdriver
    from appium.options import XCUITestOptions
    APPIUM_AVAILABLE = True
except ImportError:
    APPIUM_AVAILABLE = False

try:
    from pymobiledevice3.cli.cli_common import Command
    from pymobiledevice3.lockdown import create_using_usbmux
    PYMOBILE_AVAILABLE = True
except ImportError:
    PYMOBILE_AVAILABLE = False

from colorama import Fore, Style, init
init(autoreset=True)


def print_color(msg, color="white"):
    colors = {
        "red": Fore.RED, "green": Fore.GREEN, "yellow": Fore.YELLOW,
        "blue": Fore.BLUE, "cyan": Fore.CYAN, "magenta": Fore.MAGENTA,
        "white": Fore.WHITE,
    }
    print(f"{colors.get(color, Fore.WHITE)}{msg}{Style.RESET_ALL}")


def get_connected_devices():
    """List connected iOS devices via pymobiledevice3 or idevice_id."""
    devices = []

    # Try pymobiledevice3
    if PYMOBILE_AVAILABLE:
        try:
            result = subprocess.run(
                ["python", "-m", "pymobiledevice3", "usbmux", "list"],
                capture_output=True, text=True, timeout=10
            )
            for line in result.stdout.splitlines():
                line = line.strip()
                if line and not line.startswith("[") and not line.startswith("{"):
                    devices.append(line)
        except Exception:
            pass

    # Fallback: idevice_id (libimobiledevice)
    if not devices:
        try:
            result = subprocess.run(
                ["idevice_id", "-l"], capture_output=True, text=True, timeout=5
            )
            devices = [l.strip() for l in result.stdout.splitlines() if l.strip()]
        except Exception:
            pass

    return devices


class iOSController:
    def __init__(self, config):
        self.config     = config
        self.driver     = None
        self.screenshot_dir = Path(config.get("SCREENSHOT_DIR", "./screenshots"))
        self.screenshot_dir.mkdir(exist_ok=True)
        self._round     = 0

    def connect(self, udid=None, bundle_id=None):
        """Connect to device via Appium + WebDriverAgent."""
        if not APPIUM_AVAILABLE:
            raise RuntimeError("appium-python-client not installed. Run: pip install appium-python-client")

        udid      = udid      or self.config.get("UDID") or self._auto_detect_udid()
        bundle_id = bundle_id or self.config.get("BUNDLE_ID") or "com.apple.springboard"

        print_color(f"[→] Connecting to device: {udid or 'auto'}", "cyan")
        print_color(f"[→] App: {bundle_id}", "cyan")

        options = XCUITestOptions()
        options.platform_name        = "iOS"
        options.device_name          = self.config.get("DEVICE_NAME", "iPhone")
        options.platform_version     = self.config.get("PLATFORM_VERSION", "17.0")
        options.automation_name      = "XCUITest"
        options.bundle_id            = bundle_id
        if udid:
            options.udid = udid

        host = self.config.get("APPIUM_HOST", "127.0.0.1")
        port = self.config.get("APPIUM_PORT", 4723)

        self.driver = webdriver.Remote(
            f"http://{host}:{port}",
            options=options,
        )
        print_color("[✓] Connected to device", "green")
        return self.driver

    def _auto_detect_udid(self):
        devices = get_connected_devices()
        if devices:
            print_color(f"[→] Auto-detected device: {devices[0]}", "cyan")
            return devices[0]
        return None

    def screenshot(self, label="screen"):
        """Take screenshot, save to file, return path."""
        self._round += 1
        fname = self.screenshot_dir / f"{label}_{self._round:03d}.png"
        if self.driver:
            data = self.driver.get_screenshot_as_base64()
            with open(fname, "wb") as f:
                f.write(base64.b64decode(data))
        else:
            # Fallback: pymobiledevice3 screenshot
            subprocess.run(
                ["python", "-m", "pymobiledevice3", "developer", "screenshot", str(fname)],
                capture_output=True
            )
        if not fname.exists():
            raise RuntimeError(f"Screenshot failed — file not created: {fname}")
        return str(fname)

    def tap(self, x, y):
        """Tap at coordinates."""
        if self.driver:
            self.driver.tap([(x, y)])
            print_color(f"[→] Tap ({x}, {y})", "blue")

    def swipe(self, x1, y1, x2, y2, duration=500):
        """Swipe from (x1,y1) to (x2,y2)."""
        if self.driver:
            self.driver.swipe(x1, y1, x2, y2, duration)
            print_color(f"[→] Swipe ({x1},{y1}) → ({x2},{y2})", "blue")

    def type_text(self, text):
        """Type text into focused element."""
        if self.driver:
            el = self.driver.switch_to.active_element
            el.send_keys(text)
            print_color(f"[→] Type: {text}", "blue")

    def press_home(self):
        if self.driver:
            self.driver.execute_script("mobile: pressButton", {"name": "home"})

    def get_page_source(self):
        if self.driver:
            return self.driver.page_source
        return ""

    def disconnect(self):
        if self.driver:
            self.driver.quit()
            self.driver = None
            print_color("[✓] Disconnected", "green")
