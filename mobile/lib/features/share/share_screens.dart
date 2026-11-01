import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/widgets/finet_scaffold.dart';
import '../scan/media.dart';
import '../scan/scan_controller.dart';

/// Un PDF primit din altă aplicație poate fi un bon sau un extras bancar.
class SharedPdfScreen extends ConsumerWidget {
  const SharedPdfScreen({super.key, required this.file});

  final PickedMedia file;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FinetScaffold(
      title: 'PDF primit',
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(file.name, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          const Text('Ce este acest PDF?'),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: () {
              ref.read(scanControllerProvider.notifier).addSharedPdf(file);
              context.go('/scan');
            },
            icon: const Icon(Icons.receipt_long_outlined),
            label: const Text('Un bon sau o factură'),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () =>
                context.pushReplacement('/statements/import', extra: file),
            icon: const Icon(Icons.account_balance_outlined),
            label: const Text('Un extras bancar'),
          ),
        ],
      ),
    );
  }
}

/// O combinație de fișiere pe care aplicația nu o poate importa dintr-o dată.
class SharedUnsupportedScreen extends StatelessWidget {
  const SharedUnsupportedScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return FinetScaffold(
      title: 'Fișiere primite',
      body: const Padding(
        padding: EdgeInsets.all(24),
        child: Text(
          'Nu pot importa această combinație de fișiere. Partajează fie până la 4 poze ale '
          'aceluiași bon, fie un singur PDF, CSV sau XLSX.',
        ),
      ),
    );
  }
}
