import logging

from flask_login import UserMixin

from appwrite.exception import AppwriteException
from appwrite_client import COLLECTIONS
from appwrite_helpers import get_document_safe, parse_datetime
from extensions import login_manager


logger = logging.getLogger(__name__)


class User(UserMixin):
    def __init__(self, doc):
        data = doc or {}
        self._data = data
        self.id = data.get("$id") or data.get("id")
        self.google_id = data.get("google_id")
        self.email = data.get("email")
        self.name = data.get("name")
        self.picture_url = data.get("picture_url")
        self.onboarding_complete = bool(data.get("onboarding_complete", False))
        self.onboarding_step = data.get("onboarding_step") or 1
        self.education_level = data.get("education_level")
        self.class_year = data.get("class_year")
        self.emory_student = data.get("emory_student")
        self.emory_email = data.get("emory_email")
        self.created_at = parse_datetime(data.get("created_at"))
        self.last_login = parse_datetime(data.get("last_login"))

    def get_id(self):
        return str(self.id) if self.id is not None else None


def user_from_doc(doc):
    if not doc:
        return None
    return User(doc)


@login_manager.user_loader
def load_user(user_id):
    if not user_id:
        return None
    try:
        doc = get_document_safe(COLLECTIONS["users"], user_id)
    except AppwriteException as exc:
        if exc.code == 404:
            return None
        logger.exception("Failed to load user document")
        return None
    return User(doc)
