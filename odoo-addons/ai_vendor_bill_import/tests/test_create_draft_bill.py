"""
Basic unit tests for the AI vendor bill import addon.
These run in the Odoo test runner environment.
"""
from odoo.tests.common import TransactionCase


class TestCreateDraftBill(TransactionCase):

    def setUp(self):
        super().setUp()
        self.env["ir.config_parameter"].sudo().set_param(
            "presentail.integration_token", "test-token-abc123"
        )

    def test_find_duplicate_no_match(self):
        log_model = self.env["presentail.import.log"]
        result = log_model.find_duplicate("Unknown Vendor XYZ", "INV-999999", 100.0)
        self.assertFalse(result)

    def test_find_duplicate_missing_fields(self):
        log_model = self.env["presentail.import.log"]
        self.assertFalse(log_model.find_duplicate(None, None, None))
        self.assertFalse(log_model.find_duplicate("Vendor", None, 100.0))
        self.assertFalse(log_model.find_duplicate(None, "INV-001", 100.0))

    def test_import_log_creation(self):
        log = self.env["presentail.import.log"].create({
            "presentail_import_id": 42,
            "status": "success",
            "payload_json": {"test": True},
        })
        self.assertEqual(log.status, "success")
        self.assertEqual(log.presentail_import_id, 42)
