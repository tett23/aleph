#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"
cat > "$fixture/cert.cnf" <<'CONF'
[req]
distinguished_name = dn
x509_extensions = cert
prompt = no
[dn]
CN = localhost
[cert]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
CONF
/usr/bin/openssl req -new -x509 -days 1 -nodes -newkey rsa:2048 -keyout "$fixture/key.pem" -out "$fixture/cert.pem" -config "$fixture/cert.cnf"
/usr/bin/openssl x509 -in "$fixture/cert.pem" -outform der -out "$fixture/cert.der"
/usr/bin/clang -dynamiclib -framework CoreFoundation -framework Security -Wno-deprecated-declarations \
  -o "$fixture/anchor.dylib" "$fixture_source/secure-transport-anchor.c"
/usr/bin/ruby "$fixture_source/https.rb" "$fixture" "$fixture/port" "$git_server_dir" > "$fixture/server.log" 2>&1 &
server_pid=$!
for i in 1 2 3 4 5; do
  [ -s "$fixture/port" ] && break
  /bin/sleep 1
done
export ALEPH_TEST_HTTPS_URL="https://127.0.0.1:$(/bin/cat "$fixture/port")/remote.git"
ALEPH_TEST_REMOTE_REPO="$fixture/remote.git" PATH="$fixture/no-client-tools" "$test_binary" --exact git::remote::transport_tests::adr0105_i6_https_untrusted_certificate --ignored --nocapture
/bin/mv "$fixture/remote.git" "$fixture/untrusted.git"
ALEPH_TEST_REMOTE_REPO="$fixture/remote.git" ALEPH_TEST_TLS_CA="$fixture/cert.der" DYLD_INSERT_LIBRARIES="$fixture/anchor.dylib" PATH="$fixture/no-client-tools" "$test_binary" --exact git::remote::transport_tests::adr0105_a3_i6_i7_https_credentials_and_rejected_push --ignored --nocapture
