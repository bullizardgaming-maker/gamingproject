FROM python:3.11-slim
WORKDIR /srv
COPY requirements.txt .
# CPU-only PyTorch keeps the image small.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements.txt
COPY fraud_gnn fraud_gnn
COPY models models
# Train a bootstrap model at build time if none was provided; retrain on production labels later.
RUN [ -f models/hgt.pt ] || python -m fraud_gnn.train --synthetic --out models/hgt.pt
EXPOSE 8090
CMD ["uvicorn", "fraud_gnn.service:app", "--host", "0.0.0.0", "--port", "8090"]
