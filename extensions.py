from flask_login import LoginManager
from flask_wtf import CSRFProtect


login_manager = LoginManager()
csrf = CSRFProtect()
