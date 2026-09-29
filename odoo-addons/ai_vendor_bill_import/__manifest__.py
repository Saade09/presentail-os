{
    'name': 'AI Vendor Bill Import',
    'version': '17.0.1.0.0',
    'category': 'Accounting/Accounting',
    'summary': 'Receive AI-extracted invoice data from Presentail OS and create draft vendor bills',
    'description': """
        This addon exposes a REST API that Presentail OS calls after its AI
        extraction pipeline finishes processing a supplier PDF invoice.
        It creates a draft vendor bill (account.move) in Odoo with the
        extracted data, never auto-posting.
    """,
    'author': 'Presentail',
    'depends': ['account', 'base_setup'],
    'data': [
        'security/ir.model.access.csv',
        'security/presentail_security.xml',
        'views/presentail_import_log_views.xml',
        'data/presentail_data.xml',
    ],
    'installable': True,
    'application': False,
    'license': 'LGPL-3',
}
