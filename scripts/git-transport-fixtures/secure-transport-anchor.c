#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <stdlib.h>

static OSStatus with_fixture_anchor(SecTrustRef trust, SecTrustResultType *result) {
    const char *path = getenv("ALEPH_TEST_TLS_CA");
    if (!path) return SecTrustEvaluate(trust, result);
    unsigned char der[16384];
    FILE *file = fopen(path, "rb");
    if (!file) return errSecIO;
    size_t size = fread(der, 1, sizeof(der), file);
    fclose(file);
    CFDataRef data = CFDataCreate(NULL, der, (CFIndex)size);
    SecCertificateRef cert = SecCertificateCreateWithData(NULL, data);
    CFRelease(data);
    if (!cert) return errSecDecode;
    const void *only = cert;
    CFArrayRef anchors = CFArrayCreate(NULL, &only, 1, &kCFTypeArrayCallBacks);
    OSStatus status = SecTrustSetAnchorCertificates(trust, anchors);
    if (status == errSecSuccess) status = SecTrustSetAnchorCertificatesOnly(trust, true);
    CFRelease(anchors);
    CFRelease(cert);
    if (status != errSecSuccess) return status;
    return SecTrustEvaluate(trust, result);
}

__attribute__((used,section("__DATA,__interpose")))
static const struct { const void *replacement; const void *original; } fixture_interpose = {
    (const void *)with_fixture_anchor, (const void *)SecTrustEvaluate
};
