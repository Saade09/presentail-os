import json
import logging
from datetime import datetime

from odoo import http
from odoo.http import request, Response

_logger = logging.getLogger(__name__)

ALLOWED_STATUSES = {"success", "failed", "duplicate"}


def _verify_token(req):
    """Verify the Bearer token against the ir.config_parameter store."""
    auth_header = req.httprequest.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return False
    token = auth_header[7:]
    stored = (
        req.env["ir.config_parameter"]
        .sudo()
        .get_param("presentail.integration_token", "")
    )
    if not stored:
        _logger.warning("presentail: integration_token not configured")
        return False
    import hmac as _hmac
    return _hmac.compare_digest(token, stored)


def _json_response(data, status=200):
    return Response(
        json.dumps(data),
        status=status,
        mimetype="application/json",
    )


class PresentailAiImportController(http.Controller):

    @http.route(
        "/ai_invoice_import/api/v1/create-draft-bill",
        type="http",
        auth="none",
        methods=["POST"],
        csrf=False,
    )
    def create_draft_bill(self, **_kwargs):
        if not _verify_token(request):
            return _json_response({"success": False, "error": "Unauthorized"}, 401)

        try:
            body = json.loads(request.httprequest.data.decode("utf-8"))
        except Exception:
            return _json_response({"success": False, "error": "Invalid JSON"}, 400)

        env = request.env(user=request.env.ref("base.user_root").id)

        company_id = body.get("company_id")
        if company_id:
            company = env["res.company"].sudo().browse(int(company_id))
            if not company.exists():
                return _json_response({"success": False, "error": "Company not found"}, 400)
            env = env(company=company)

        presentail_import_id = body.get("presentail_import_id")
        vendor_name = body.get("vendor_name") or ""
        invoice_number = body.get("invoice_number") or ""
        invoice_date_raw = body.get("invoice_date")
        due_date_raw = body.get("due_date")
        currency_code = body.get("currency", "USD")
        total_amount = body.get("total_amount")
        line_items = body.get("line_items", [])

        if not isinstance(line_items, list):
            line_items = []

        is_dup = env["presentail.import.log"].sudo().find_duplicate(
            vendor_name, invoice_number, total_amount
        )
        if is_dup:
            env["presentail.import.log"].sudo().create({
                "presentail_import_id": presentail_import_id or 0,
                "status": "duplicate",
                "payload_json": body,
            })
            return _json_response({
                "success": False,
                "error": "Duplicate invoice detected",
                "duplicate": True,
            }, 409)

        partner = env["res.partner"].sudo().search(
            [("name", "ilike", vendor_name)], limit=1
        )
        if not partner and vendor_name:
            partner = env["res.partner"].sudo().create({
                "name": vendor_name,
                "company_type": "company",
                "vat": body.get("vendor_tax_number"),
            })

        currency = env["res.currency"].sudo().search(
            [("name", "=", currency_code)], limit=1
        )

        invoice_date = None
        if invoice_date_raw:
            try:
                invoice_date = datetime.strptime(invoice_date_raw, "%Y-%m-%d").date()
            except ValueError:
                pass

        invoice_date_due = None
        if due_date_raw:
            try:
                invoice_date_due = datetime.strptime(due_date_raw, "%Y-%m-%d").date()
            except ValueError:
                pass

        move_vals = {
            "move_type": "in_invoice",
            "partner_id": partner.id if partner else False,
            "ref": invoice_number or False,
            "invoice_date": invoice_date,
            "invoice_date_due": invoice_date_due,
            "currency_id": currency.id if currency else False,
            "narration": f"Imported by Presentail OS AI Invoice Import (import #{presentail_import_id})",
        }

        invoice_lines = []
        for item in line_items:
            desc = item.get("description") or "Invoice line"
            qty = float(item.get("quantity") or 1)
            price = float(item.get("unit_price") or 0)
            invoice_lines.append((0, 0, {
                "name": desc,
                "quantity": qty,
                "price_unit": price,
            }))

        if invoice_lines:
            move_vals["invoice_line_ids"] = invoice_lines
        else:
            if total_amount is not None:
                move_vals["invoice_line_ids"] = [(0, 0, {
                    "name": "Invoice total (AI extracted — verify line items)",
                    "quantity": 1,
                    "price_unit": float(total_amount),
                })]

        try:
            move = env["account.move"].sudo().create(move_vals)
        except Exception as exc:
            _logger.error("presentail: failed to create vendor bill: %s", exc)
            env["presentail.import.log"].sudo().create({
                "presentail_import_id": presentail_import_id or 0,
                "status": "failed",
                "error_message": str(exc),
                "payload_json": body,
            })
            return _json_response({"success": False, "error": str(exc)}, 500)

        env["presentail.import.log"].sudo().create({
            "presentail_import_id": presentail_import_id or 0,
            "vendor_bill_id": move.id,
            "status": "success",
            "payload_json": body,
        })

        base_url = env["ir.config_parameter"].sudo().get_param("web.base.url", "")
        bill_url = f"{base_url}/odoo/accounting/vendor-bills/{move.id}" if base_url else None

        return _json_response({
            "success": True,
            "bill_id": move.id,
            "bill_url": bill_url,
        })

    @http.route(
        "/ai_invoice_import/api/v1/bill-status/<int:bill_id>",
        type="http",
        auth="none",
        methods=["GET"],
        csrf=False,
    )
    def bill_status(self, bill_id, **_kwargs):
        if not _verify_token(request):
            return _json_response({"success": False, "error": "Unauthorized"}, 401)

        env = request.env(user=request.env.ref("base.user_root").id)
        move = env["account.move"].sudo().browse(bill_id)
        if not move.exists() or move.move_type != "in_invoice":
            return _json_response({"success": False, "error": "Bill not found"}, 404)

        base_url = env["ir.config_parameter"].sudo().get_param("web.base.url", "")
        bill_url = f"{base_url}/odoo/accounting/vendor-bills/{move.id}" if base_url else None

        return _json_response({
            "success": True,
            "status": move.state,
            "url": bill_url,
        })

    @http.route(
        "/ai_invoice_import/api/v1/settings/sync",
        type="http",
        auth="none",
        methods=["POST"],
        csrf=False,
    )
    def settings_sync(self, **_kwargs):
        if not _verify_token(request):
            return _json_response({"success": False, "error": "Unauthorized"}, 401)
        return _json_response({"success": True})
