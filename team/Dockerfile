# One image for the Python services of the Bolashak solution:
# twin setup, simulator, protection (ПАЗ) and the dispatcher advisor.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY minecore ./minecore
COPY sim ./sim
COPY paz ./paz
COPY advisor ./advisor
CMD ["python", "-m", "sim.simulator"]
