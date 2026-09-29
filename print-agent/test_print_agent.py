"""
Unit tests for print-agent.py

Covers pure-logic helpers that have no external I/O dependencies.
Network calls, subprocess calls, and file I/O are mocked where needed.
"""

import hashlib
import json
import os
import platform
import socket
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, mock_open, patch

_agent_path = Path(__file__).parent / "print-agent.py"
_spec = importlib.util.spec_from_file_location("print_agent", _agent_path)
pa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pa)


class TestNorm(unittest.TestCase):
    def test_strips_whitespace(self):
        self.assertEqual(pa._norm("  https://example.com  "), "https://example.com")

    def test_strips_trailing_slash(self):
        self.assertEqual(pa._norm("https://example.com/"), "https://example.com")

    def test_strips_multiple_trailing_slashes(self):
        self.assertEqual(pa._norm("https://example.com///"), "https://example.com")

    def test_none_returns_empty_string(self):
        self.assertEqual(pa._norm(None), "")

    def test_empty_string(self):
        self.assertEqual(pa._norm(""), "")


class TestIsOriginAllowed(unittest.TestCase):
    def test_trusted_origin_allowed(self):
        self.assertTrue(pa.is_origin_allowed("https://print.presentail.com"))

    def test_trusted_origin_with_trailing_slash(self):
        self.assertTrue(pa.is_origin_allowed("https://print.presentail.com/"))

    def test_trusted_origin_with_leading_whitespace(self):
        self.assertTrue(pa.is_origin_allowed("  https://print.presentail.com  "))

    def test_unknown_origin_rejected(self):
        self.assertFalse(pa.is_origin_allowed("https://evil.example.com"))

    def test_empty_origin_rejected(self):
        self.assertFalse(pa.is_origin_allowed(""))

    def test_none_origin_rejected(self):
        self.assertFalse(pa.is_origin_allowed(None))

    def test_subdomain_not_allowed(self):
        self.assertFalse(pa.is_origin_allowed("https://sub.print.presentail.com"))

    def test_http_variant_rejected(self):
        self.assertFalse(pa.is_origin_allowed("http://print.presentail.com"))


class TestIsApiUrlAllowed(unittest.TestCase):
    def test_trusted_url_allowed(self):
        self.assertTrue(pa.is_api_url_allowed("https://print.presentail.com"))

    def test_trusted_url_with_trailing_slash(self):
        self.assertTrue(pa.is_api_url_allowed("https://print.presentail.com/"))

    def test_unknown_url_rejected(self):
        self.assertFalse(pa.is_api_url_allowed("https://attacker.com"))

    def test_empty_url_rejected(self):
        self.assertFalse(pa.is_api_url_allowed(""))

    def test_none_url_rejected(self):
        self.assertFalse(pa.is_api_url_allowed(None))


class TestGetOsString(unittest.TestCase):
    def test_darwin(self):
        with patch("platform.system", return_value="Darwin"), \
             patch("platform.mac_ver", return_value=("14.1", ("", "", ""), "")):
            result = pa.get_os_string()
        self.assertEqual(result, "macOS 14.1")

    def test_linux(self):
        with patch("platform.system", return_value="Linux"), \
             patch("platform.release", return_value="5.15.0"):
            result = pa.get_os_string()
        self.assertEqual(result, "Linux 5.15.0")

    def test_windows(self):
        with patch("platform.system", return_value="Windows"), \
             patch("platform.release", return_value="10"):
            result = pa.get_os_string()
        self.assertEqual(result, "Windows 10")

    def test_unknown_platform(self):
        with patch("platform.system", return_value="FreeBSD"):
            result = pa.get_os_string()
        self.assertEqual(result, "FreeBSD")

    def test_empty_platform(self):
        with patch("platform.system", return_value=""):
            result = pa.get_os_string()
        self.assertEqual(result, "Unknown")


class TestGetMachineIdFallback(unittest.TestCase):
    def test_fallback_is_deterministic(self):
        hostname = "test-host"
        system = "Linux"
        node = "test-host"
        fingerprint = f"{hostname}|{system}|{node}"
        expected = hashlib.sha256(fingerprint.encode()).hexdigest()[:32]

        with patch("platform.system", return_value="Linux"), \
             patch("subprocess.run", side_effect=Exception("no ioreg")), \
             patch("os.path.exists", return_value=False), \
             patch("socket.gethostname", return_value=hostname), \
             patch("platform.node", return_value=node):
            result = pa.get_machine_id()

        self.assertEqual(result, expected)

    def test_fallback_result_is_32_chars(self):
        with patch("platform.system", return_value="Unknown"), \
             patch("subprocess.run", side_effect=Exception("fail")), \
             patch("os.path.exists", return_value=False):
            result = pa.get_machine_id()
        self.assertEqual(len(result), 32)

    def test_linux_reads_machine_id_file(self):
        fake_id = "abcdef1234567890abcdef1234567890"
        with patch("platform.system", return_value="Linux"), \
             patch("os.path.exists", side_effect=lambda p: p == "/etc/machine-id"), \
             patch("builtins.open", mock_open(read_data=fake_id + "\n")):
            result = pa.get_machine_id()
        self.assertEqual(result, fake_id)


class TestLoadConfig(unittest.TestCase):
    def test_returns_none_when_file_missing(self):
        with patch("builtins.open", side_effect=OSError("no file")):
            result = pa.load_config()
        self.assertIsNone(result)

    def test_returns_none_when_json_invalid(self):
        with patch("builtins.open", mock_open(read_data="not-json")):
            result = pa.load_config()
        self.assertIsNone(result)

    def test_returns_none_when_api_key_missing(self):
        cfg = json.dumps({"api_url": "https://print.presentail.com"})
        with patch("builtins.open", mock_open(read_data=cfg)):
            result = pa.load_config()
        self.assertIsNone(result)

    def test_returns_none_when_api_url_missing(self):
        cfg = json.dumps({"api_key": "pk_live_abc"})
        with patch("builtins.open", mock_open(read_data=cfg)):
            result = pa.load_config()
        self.assertIsNone(result)

    def test_returns_config_when_valid(self):
        cfg = json.dumps({"api_key": "pk_live_abc", "api_url": "https://print.presentail.com"})
        with patch("builtins.open", mock_open(read_data=cfg)):
            result = pa.load_config()
        self.assertIsNotNone(result)
        self.assertEqual(result["api_key"], "pk_live_abc")
        self.assertEqual(result["api_url"], "https://print.presentail.com")


class TestGetPrinters(unittest.TestCase):
    def test_parses_lpstat_output(self):
        fake_output = "HP_LaserJet accepting requests since Mon 01 Jan 2024\nCanon_Pixma accepting requests since Mon 01 Jan 2024\n"
        mock_result = MagicMock()
        mock_result.stdout = fake_output
        with patch("subprocess.run", return_value=mock_result):
            printers = pa.get_printers()
        self.assertEqual(printers, ["HP_LaserJet", "Canon_Pixma"])

    def test_returns_empty_list_on_error(self):
        with patch("subprocess.run", side_effect=Exception("lpstat not found")):
            printers = pa.get_printers()
        self.assertEqual(printers, [])

    def test_returns_empty_list_when_no_printers(self):
        mock_result = MagicMock()
        mock_result.stdout = ""
        with patch("subprocess.run", return_value=mock_result):
            printers = pa.get_printers()
        self.assertEqual(printers, [])


class TestWriteConfig(unittest.TestCase):
    def test_writes_json_with_correct_keys(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir) / ".print-agent"
            config_path = config_dir / "config.json"
            with patch.object(pa, "CONFIG_DIR", config_dir), \
                 patch.object(pa, "CONFIG_PATH", config_path):
                pa.write_config("pk_live_test", "https://print.presentail.com")
            written = json.loads(config_path.read_text())
        self.assertEqual(written["api_key"], "pk_live_test")
        self.assertEqual(written["api_url"], "https://print.presentail.com")


if __name__ == "__main__":
    unittest.main()
