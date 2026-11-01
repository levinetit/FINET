import 'dart:convert';
import 'dart:typed_data';

/// O parte dintr-un corp `multipart/form-data`.
class Part {
  Part(this.name, this.filename, this.contentType, this.bytes);

  final String name;
  final String? filename;
  final String? contentType;
  final Uint8List bytes;

  String get text => utf8.decode(bytes);
}

/// Împarte un corp multipart în părți, în ordinea în care au fost scrise (ordinea contează:
/// serverul citește fluxul, deci câmpurile text trebuie să vină înaintea fișierelor).
List<Part> parseMultipart(Uint8List body, String contentType) {
  final boundary = RegExp(r'boundary=(?:"([^"]+)"|([^;]+))')
      .firstMatch(contentType)!
      .let((m) => m.group(1) ?? m.group(2)!);
  final delimiter = latin1.encode('--$boundary');
  final starts = <int>[];
  for (var i = 0; i + delimiter.length <= body.length; i++) {
    var match = true;
    for (var j = 0; j < delimiter.length; j++) {
      if (body[i + j] != delimiter[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      starts.add(i);
      i += delimiter.length - 1;
    }
  }
  final parts = <Part>[];
  for (var k = 0; k + 1 < starts.length; k++) {
    // După delimitator urmează CRLF, antetele, CRLFCRLF, conținutul și CRLF înaintea următorului.
    final from = starts[k] + delimiter.length + 2;
    final to = starts[k + 1] - 2;
    final chunk = body.sublist(from, to);
    final sep = _indexOf(chunk, latin1.encode('\r\n\r\n'));
    final head = latin1.decode(chunk.sublist(0, sep));
    final content = Uint8List.fromList(chunk.sublist(sep + 4));
    final name = RegExp(r'name="([^"]*)"').firstMatch(head)!.group(1)!;
    final filename = RegExp(r'filename="([^"]*)"').firstMatch(head)?.group(1);
    final type = RegExp(
      r'content-type:\s*([^\r\n]+)',
      caseSensitive: false,
    ).firstMatch(head)?.group(1);
    parts.add(Part(name, filename, type, content));
  }
  return parts;
}

int _indexOf(List<int> haystack, List<int> needle) {
  for (var i = 0; i + needle.length <= haystack.length; i++) {
    var ok = true;
    for (var j = 0; j < needle.length; j++) {
      if (haystack[i + j] != needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

extension<T> on T {
  R let<R>(R Function(T) f) => f(this);
}
