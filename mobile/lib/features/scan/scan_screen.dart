import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/tokens.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../receipts/strings.dart';
import '../usage/usage_tracker.dart';
import 'media.dart';
import 'providers.dart';
import 'scan_controller.dart';

/// Scanează: fotografiezi un bon (sau alegi poze ori un PDF), vezi previzualizarea, ordonezi pozele
/// unui bon lung și încarci. Citirea o face serverul FINET; telefonul nu trimite nimic către
/// furnizori AI.
class ScanScreen extends ConsumerWidget {
  const ScanScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(scanControllerProvider.select((s) => s.result), (_, next) {
      if (next != null) context.push('/scan/status');
    });
    final state = ref.watch(scanControllerProvider);
    final controller = ref.read(scanControllerProvider.notifier);
    final usage = ref.watch(aiUsageProvider).asData?.value;
    final busy = state.uploading;
    final c = context.finet;
    return FinetScaffold(
      title: 'Scanează',
      screen: UsageScreens.scan,
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (usage != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(
                '${usage.used} din ${usage.limit} documente citite azi',
                style: TextStyle(color: c.muted),
              ),
            ),
          FilledButton.icon(
            onPressed: busy ? null : controller.addFromCamera,
            icon: const Icon(Icons.photo_camera_outlined),
            label: const Text('Fotografiază bonul'),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: busy ? null : controller.addFromGallery,
            icon: const Icon(Icons.photo_library_outlined),
            label: const Text('Alege din galerie'),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: busy ? null : controller.addPdf,
            icon: const Icon(Icons.picture_as_pdf_outlined),
            label: const Text('Alege un PDF'),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: busy ? null : () => context.push('/statements/import'),
            icon: const Icon(Icons.account_balance_outlined),
            label: const Text('Importă un extras bancar'),
          ),
          const SizedBox(height: 8),
          TextButton.icon(
            onPressed: () => context.push('/receipts'),
            icon: const Icon(Icons.receipt_long_outlined),
            label: const Text('Bonurile mele'),
          ),
          if (state.items.isNotEmpty) ...[
            const Divider(height: 32),
            Text(
              state.hasPdf ? 'PDF de încărcat' : 'Poze de încărcat',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            for (var i = 0; i < state.items.length; i++)
              _ShotTile(
                index: i,
                media: state.items[i],
                count: state.items.length,
                busy: busy,
              ),
            if (!state.hasPdf)
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Bon lung (2–4 poze)'),
                subtitle: const Text(
                  'Pozele sunt părți ale aceluiași bon, în ordine de sus în jos.',
                ),
                value: state.longReceipt,
                onChanged: busy ? null : controller.setLongReceipt,
              ),
            if (state.message != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(state.message!, style: TextStyle(color: c.bad)),
              ),
            if (state.error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  uploadErrorText(state.error!),
                  style: TextStyle(color: c.bad),
                ),
              ),
            const SizedBox(height: 12),
            if (busy)
              const Center(child: CircularProgressIndicator())
            else
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: controller.cancel,
                      child: const Text('Anulează'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton(
                      onPressed: controller.submit,
                      child: Text(
                        state.error == null ? 'Încarcă' : 'Încearcă din nou',
                      ),
                    ),
                  ),
                ],
              ),
          ],
        ],
      ),
    );
  }
}

class _ShotTile extends ConsumerWidget {
  const _ShotTile({
    required this.index,
    required this.media,
    required this.count,
    required this.busy,
  });

  final int index;
  final PickedMedia media;
  final int count;
  final bool busy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.read(scanControllerProvider.notifier);
    final isImage = media.kind == MediaKind.image;
    return Card(
      child: ListTile(
        leading: isImage
            ? ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: Image.file(
                  File(media.path),
                  width: 48,
                  height: 48,
                  fit: BoxFit.cover,
                  cacheWidth: 144,
                  excludeFromSemantics: true,
                  errorBuilder: (_, _, _) =>
                      const Icon(Icons.image_not_supported_outlined),
                ),
              )
            : const Icon(Icons.picture_as_pdf_outlined),
        title: Text(
          count > 1 ? 'Poza ${index + 1} din $count' : media.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text(
          media.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        trailing: Wrap(
          children: [
            if (count > 1) ...[
              IconButton(
                tooltip: 'Mută mai sus',
                onPressed: busy || index == 0
                    ? null
                    : () => controller.reorder(index, index - 1),
                icon: const Icon(Icons.arrow_upward),
              ),
              IconButton(
                tooltip: 'Mută mai jos',
                onPressed: busy || index == count - 1
                    ? null
                    : () => controller.reorder(index, index + 2),
                icon: const Icon(Icons.arrow_downward),
              ),
            ],
            IconButton(
              tooltip: 'Scoate poza',
              onPressed: busy ? null : () => controller.remove(index),
              icon: const Icon(Icons.close),
            ),
          ],
        ),
      ),
    );
  }
}
