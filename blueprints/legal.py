"""Public legal document pages."""

import logging

from appwrite.exception import AppwriteException
from appwrite.query import Query
from flask import Blueprint, make_response, render_template
from flask_login import current_user

from appwrite_client import COLLECTIONS
from appwrite_helpers import list_rows_safe


legal_bp = Blueprint("legal", __name__)
logger = logging.getLogger(__name__)


LEGAL_DOCUMENTS = {
    "privacy": {
        "active_key": "privacy",
        "route": "legal.privacy_policy",
        "title": "Privacy Policy",
        "description": "How Nest.APStudy collects, uses, stores, and protects your data.",
        "intro": (
            'Your privacy matters to us. This Privacy Policy explains what personal data '
            'Nest.APStudy ("we," "us," "our," or "the Service") collects, how we use it, '
            "and what choices you have."
        ),
        "last_updated": "June 2025",
        "sections": [
            ("information-we-collect", "Information We Collect"),
            ("how-we-use-your-information", "How We Use Your Information"),
            ("data-storage-and-infrastructure", "Data Storage and Infrastructure"),
            ("cookie-policy", "Cookie Policy"),
            ("data-retention", "Data Retention"),
            ("who-we-share-data-with", "Who We Share Data With"),
            ("your-rights-and-choices", "Your Rights and Choices"),
            ("data-deletion-and-account-deletion", "Data Deletion and Account Deletion"),
            ("security", "Security"),
            ("childrens-privacy", "Children's Privacy"),
            ("changes-to-this-policy", "Changes to This Policy"),
            ("contact-us", "Contact Us"),
        ],
    },
    "terms": {
        "active_key": "terms",
        "route": "legal.terms_of_service",
        "title": "Terms of Service",
        "description": "The rules and responsibilities that apply when you use Nest.APStudy.",
        "intro": (
            'Welcome to Nest.APStudy ("the Service"). These Terms of Service ("Terms") '
            "govern your access to and use of the Service."
        ),
        "last_updated": "June 2025",
        "sections": [
            ("about-the-service", "About the Service"),
            ("eligibility", "Eligibility"),
            ("account-registration-and-responsibility", "Account Registration and Responsibility"),
            ("acceptable-use", "Acceptable Use"),
            ("user-generated-content", "User-Generated Content"),
            ("academic-data-disclaimer", "Academic Data Disclaimer"),
            ("service-availability", "Service Availability"),
            ("suspension-and-termination", "Suspension and Termination"),
            ("intellectual-property", "Intellectual Property"),
            ("disclaimer-of-warranties", "Disclaimer of Warranties"),
            ("limitation-of-liability", "Limitation of Liability"),
            ("indemnification", "Indemnification"),
            ("governing-law-and-disputes", "Governing Law and Disputes"),
            ("data-deletion", "Data Deletion"),
            ("changes-to-these-terms", "Changes to These Terms"),
            ("severability", "Severability"),
            ("entire-agreement", "Entire Agreement"),
            ("no-waiver", "No Waiver"),
            ("contact", "Contact"),
        ],
    },
}


def _viewer_context():
    if not current_user.is_authenticated:
        return {
            "viewer": None,
            "theme_preference": "system-match",
        }

    theme_preference = "system-match"
    try:
        settings_response = list_rows_safe(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [str(current_user.id)]), Query.limit(1)],
        )
        rows = settings_response.get("rows", [])
        if rows:
            theme_preference = rows[0].get("interface_theme") or theme_preference
    except AppwriteException:
        logger.exception("Failed to load legal page theme preference")

    return {
        "viewer": {
            "email": current_user.email,
            "picture": current_user.picture_url,
            "emory_student": current_user.emory_student,
        },
        "theme_preference": theme_preference,
    }


def _render_legal_document(document_key):
    document = LEGAL_DOCUMENTS[document_key]
    context = _viewer_context()
    response = make_response(render_template(
        "legal_document.html",
        document=document,
        documents=LEGAL_DOCUMENTS,
        **context,
    ))
    return response


@legal_bp.route("/privacy-policy")
def privacy_policy():
    """Render the public Privacy Policy."""
    return _render_legal_document("privacy")


@legal_bp.route("/terms-of-service")
def terms_of_service():
    """Render the public Terms of Service."""
    return _render_legal_document("terms")
