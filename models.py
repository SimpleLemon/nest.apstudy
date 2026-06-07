import logging

from flask_login import UserMixin

from appwrite.exception import AppwriteException
from appwrite_client import COLLECTIONS
from appwrite_helpers import get_row_safe, parse_datetime
from extensions import login_manager


logger = logging.getLogger(__name__)


class User(UserMixin):
    def __init__(self, doc):
        data = doc or {}
        self._data = data
        self.id = data.get("$id") or data.get("id")
        self.google_id = data.get("google_id")
        self.provider = data.get("provider")
        self.email = data.get("email")
        self.name = data.get("name")
        self.username = data.get("username")
        self.picture_url = data.get("picture_url")
        self.picture = self.picture_url
        self.banner_color = data.get("banner_color") or "#fecae1"
        self.avatar_file_id = data.get("avatar_file_id")
        self.avatar_source = data.get("avatar_source")
        self.onboarding_complete = bool(data.get("onboarding_complete", False))
        self.onboarding_step = data.get("onboarding_step") or 1
        self.education_level = data.get("education_level")
        self.class_year = data.get("class_year")
        self.school = data.get("school")
        self.school_key = data.get("school_key")
        self.school_source = data.get("school_source")
        self.scorecard_id = data.get("scorecard_id")
        self.major = data.get("major")
        self.graduation_year = data.get("graduation_year")
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
        doc = get_row_safe(COLLECTIONS["users"], user_id, allow_missing=True)
    except AppwriteException as exc:
        logger.exception("Failed to load user row")
        return None
    return User(doc) if doc else None
