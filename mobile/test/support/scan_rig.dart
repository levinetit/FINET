import 'package:finet_mobile/features/scan/media.dart';
import 'package:finet_mobile/features/scan/providers.dart';
import 'package:finet_mobile/features/share/share_source.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_media.dart';
import 'fake_receipts.dart';
import 'fake_share.dart';
import 'fake_statements.dart';
import 'harness.dart';

/// Aplicația cu serverul de bonuri, selectorul de poze, pregătirea și ștergerea fișierelor false.
class ScanRig {
  ScanRig._(
    this.h,
    this.rec,
    this.picker,
    this.norm,
    this.temp,
    this.stm,
    this.share,
  );

  final Harness h;
  final FakeReceipts rec;
  final FakeMediaPicker picker;
  final FakeNormalizer norm;
  final FakeTempFiles temp;
  final FakeStatements stm;
  final FakeShareSource share;

  static Future<ScanRig> open(
    WidgetTester tester, {
    bool openScan = true,
    bool signedIn = true,
    List<PickedMedia> sharedAtStart = const [],
  }) async {
    final picker = FakeMediaPicker();
    final norm = FakeNormalizer();
    final temp = FakeTempFiles();
    final share = FakeShareSource()..initial = [...sharedAtStart];
    final h = Harness(
      overrides: [
        mediaPickerProvider.overrideWithValue(picker),
        mediaNormalizerProvider.overrideWithValue(norm),
        tempFilesProvider.overrideWithValue(temp),
        shareSourceProvider.overrideWithValue(share),
        pollDelayProvider.overrideWithValue(
          (_) => const Duration(milliseconds: 10),
        ),
      ],
    );
    if (signedIn) h.signedInStore();
    final rec = FakeReceipts(h.server);
    final stm = FakeStatements(h.server);
    await h.pump(tester);
    if (signedIn && openScan) await tester.openTab('Scanează');
    return ScanRig._(h, rec, picker, norm, temp, stm, share);
  }
}

PickedMedia photo(String name) => PickedMedia(path: '/cache/$name', name: name);
