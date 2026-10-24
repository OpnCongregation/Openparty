# ElectionGuard service: the encrypted count. Python 3.10 because electionguard 1.4.0 predates a Python 3.11 dataclass change.
# The package metadata also pulls in GUI and database libraries (Eel, pymongo, gevent...) that need a C compiler and that this
# service never uses, so the cryptographic core is installed without its declared dependencies and the few it really needs are
# pinned in requirements.txt.
FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /srv
COPY requirements.txt ./
RUN pip install --no-deps electionguard==1.4.0 && pip install -r requirements.txt
COPY app ./app
# No shell, no root, no writable app directory. State lives in the platform's database, never here.
RUN useradd --system --uid 10001 --no-create-home eg && chmod -R a-w /srv
USER 10001
EXPOSE 8090
CMD ["python", "-m", "app.server"]
