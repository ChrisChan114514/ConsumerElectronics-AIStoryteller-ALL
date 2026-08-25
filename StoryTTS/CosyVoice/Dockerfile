FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt
COPY server.py story.txt ./
COPY voices ./voices
EXPOSE 2224
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "2224"]
