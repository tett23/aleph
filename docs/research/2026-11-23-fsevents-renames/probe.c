#include <CoreServices/CoreServices.h>
#include <stdio.h>
static int seq = 0;
static void cb(ConstFSEventStreamRef s, void *i, size_t n, void *paths, const FSEventStreamEventFlags f[], const FSEventStreamEventId ids[]) {
  CFArrayRef a = (CFArrayRef)paths; seq++;
  for (size_t k = 0; k < n; k++) {
    CFDictionaryRef d = CFArrayGetValueAtIndex(a, k);
    CFStringRef p = CFDictionaryGetValue(d, kFSEventStreamEventExtendedDataPathKey);
    CFNumberRef fid = CFDictionaryGetValue(d, kFSEventStreamEventExtendedFileIDKey);
    long long v = -1; if (fid) CFNumberGetValue(fid, kCFNumberLongLongType, &v);
    char buf[1024]; CFStringGetCString(p, buf, sizeof buf, kCFStringEncodingUTF8);
    printf("callback=%d id=%llu flags=0x%x renamed=%d own=%d fileID=%lld %s\n", seq, ids[k], f[k], !!(f[k]&kFSEventStreamEventFlagItemRenamed), !!(f[k]&kFSEventStreamEventFlagOwnEvent), v, buf);
  }
  fflush(stdout);
}
int main(int c, char **v) {
  CFStringRef p = CFStringCreateWithCString(NULL, v[1], kCFStringEncodingUTF8);
  CFArrayRef ps = CFArrayCreate(NULL, (const void **)&p, 1, NULL);
  FSEventStreamRef s = FSEventStreamCreate(NULL, cb, NULL, ps, kFSEventStreamEventIdSinceNow, 0.1,
    kFSEventStreamCreateFlagFileEvents|kFSEventStreamCreateFlagNoDefer|kFSEventStreamCreateFlagWatchRoot|kFSEventStreamCreateFlagUseCFTypes|kFSEventStreamCreateFlagUseExtendedData|kFSEventStreamCreateFlagMarkSelf);
  dispatch_queue_t q = dispatch_queue_create("w", NULL);
  FSEventStreamSetDispatchQueue(s, q); FSEventStreamStart(s);
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, atof(v[2]), false);
  return 0;
}
