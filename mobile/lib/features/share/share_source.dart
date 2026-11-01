import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../scan/media.dart';

/// Fișierele primite din „Partajează" (Android). Partea nativă le copiază în memoria temporară a
/// aplicației (doar URI-uri `content://`); aici ajung doar căi și nume. Interfața permite
/// înlocuirea în teste.
abstract class ShareSource {
  /// Fișierele cu care a pornit aplicația (pornire la rece), o singură dată.
  Future<List<PickedMedia>> takeInitial();

  /// Fișierele primite cât aplicația rulează.
  void listen(void Function(List<PickedMedia> files) onShared);
}

class ChannelShareSource implements ShareSource {
  static const _channel = MethodChannel('ro.finet.app/share');

  static List<PickedMedia> _parse(Object? raw) {
    if (raw is! List) return const [];
    final out = <PickedMedia>[];
    for (final item in raw) {
      if (item is! Map) continue;
      final path = item['path'];
      final name = item['name'];
      if (path is String && name is String) {
        out.add(PickedMedia(path: path, name: name));
      }
    }
    return out;
  }

  @override
  Future<List<PickedMedia>> takeInitial() async {
    try {
      return _parse(await _channel.invokeMethod<Object?>('takeInitial'));
    } on MissingPluginException {
      return const [];
    }
  }

  @override
  void listen(void Function(List<PickedMedia> files) onShared) {
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'shared') onShared(_parse(call.arguments));
    });
  }
}

final shareSourceProvider = Provider<ShareSource>((_) => ChannelShareSource());

/// Fișierele primite și încă neprocesate. Rămân aici cât timp utilizatorul nu e autentificat sau
/// aplicația e blocată; importul continuă după autentificare. La deconectare se golesc.
class PendingShare extends Notifier<List<PickedMedia>> {
  @override
  List<PickedMedia> build() => const [];

  void add(List<PickedMedia> files) {
    if (files.isNotEmpty) state = [...state, ...files];
  }

  List<PickedMedia> take() {
    final files = state;
    state = const [];
    return files;
  }
}

final pendingShareProvider = NotifierProvider<PendingShare, List<PickedMedia>>(
  PendingShare.new,
);
