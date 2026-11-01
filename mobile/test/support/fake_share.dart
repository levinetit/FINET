import 'package:finet_mobile/features/scan/media.dart';
import 'package:finet_mobile/features/share/share_source.dart';

/// Sursa de partajare din teste: pornire la rece (`initial`) sau partajare cât rulează aplicația.
class FakeShareSource implements ShareSource {
  List<PickedMedia> initial = [];
  void Function(List<PickedMedia>)? _onShared;

  @override
  Future<List<PickedMedia>> takeInitial() async {
    final files = initial;
    initial = [];
    return files;
  }

  @override
  void listen(void Function(List<PickedMedia> files) onShared) =>
      _onShared = onShared;

  void share(List<PickedMedia> files) => _onShared?.call(files);
}
