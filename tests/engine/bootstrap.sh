#!/bin/sh
# 컨테이너 안에서 engine_facts.sh 를 실행하기 위한 준비.
# 이미지에 openssl/nc 바이너리가 없을 수 있으므로 여기서 보충한다.
set -u

if ! command -v openssl >/dev/null 2>&1 || ! command -v nc >/dev/null 2>&1; then
  (apk add --no-cache openssl busybox-extras >/dev/null 2>&1) || true
fi

mkdir -p /tmp/bary-certs
if command -v openssl >/dev/null 2>&1; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -subj "/CN=t.example.com" \
    -addext "subjectAltName=DNS:t.example.com,DNS:strict.example.com" \
    -keyout /tmp/bary-certs/key.pem -out /tmp/bary-certs/cert.pem >/dev/null 2>&1 \
    || echo "WARN: 인증서 생성 실패 — ssl 케이스가 실패할 수 있다"
else
  echo "WARN: openssl 없음 — ssl 케이스가 실패할 수 있다"
fi

cp /bary-tests/engine_facts.sh /tmp/engine_facts.sh
chmod +x /tmp/engine_facts.sh
exec /tmp/engine_facts.sh
