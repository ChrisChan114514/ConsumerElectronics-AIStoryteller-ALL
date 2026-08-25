FROM pytorch/pytorch:2.7.0-cuda12.8-cudnn9-runtime

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt
COPY server.py story.txt ./
COPY voices ./voices
EXPOSE 2223
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "2223"]
