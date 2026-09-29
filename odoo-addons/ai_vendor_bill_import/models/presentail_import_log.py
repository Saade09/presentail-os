from odoo import models, fields, api
import logging

_logger = logging.getLogger(__name__)


class PresentailImportLog(models.Model):
    """Audit log of every invoice import received from Presentail OS."""

    _name = "presentail.import.log"
    _description = "Presentail AI Invoice Import Log"
    _order = "create_date desc"
    _rec_name = "presentail_import_id"

    presentail_import_id = fields.Integer(
        string="Presentail Import ID",
        required=True,
        index=True,
    )
    vendor_bill_id = fields.Many2one(
        comodel_name="account.move",
        string="Vendor Bill",
        ondelete="set null",
    )
    status = fields.Selection(
        selection=[
            ("success", "Success"),
            ("failed", "Failed"),
            ("duplicate", "Duplicate"),
        ],
        required=True,
        default="success",
    )
    error_message = fields.Text(string="Error Message")
    payload_json = fields.Json(string="Raw Payload")
    company_id = fields.Many2one(
        comodel_name="res.company",
        string="Company",
        required=True,
        default=lambda self: self.env.company,
    )

    @api.model
    def find_duplicate(self, vendor_name, invoice_number, total_amount):
        """Return True if a bill with these identifiers already exists."""
        if not invoice_number or not vendor_name:
            return False
        partner = self.env["res.partner"].search(
            [("name", "ilike", vendor_name)], limit=1
        )
        if not partner:
            return False
        existing = self.env["account.move"].search(
            [
                ("move_type", "=", "in_invoice"),
                ("partner_id", "=", partner.id),
                ("ref", "=", invoice_number),
                ("state", "!=", "cancel"),
            ],
            limit=1,
        )
        return bool(existing)
