import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/privacy.dart';
import 'logo.dart';
import 'states.dart';

/// Cadrul comun al ecranelor: logo-ul în bara de sus, comutatorul „ascunde sumele” și, cât timp
/// datele sunt simulate, banda „Date simulate”.
class FinetScaffold extends ConsumerWidget {
  const FinetScaffold({
    super.key,
    required this.title,
    required this.body,
    this.mock = true,
    this.floatingActionButton,
  });

  final String title;
  final Widget body;

  /// `true` cât timp ecranul afișează date simulate (toate, în Faza A).
  final bool mock;
  final Widget? floatingActionButton;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hidden = ref.watch(hideAmountsProvider);
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 16,
        title: Row(
          children: [
            const FinetLogo(height: 24),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                title,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: hidden ? 'Arată sumele' : 'Ascunde sumele',
            icon: Icon(
              hidden
                  ? Icons.visibility_off_outlined
                  : Icons.visibility_outlined,
            ),
            onPressed: () => ref.read(hideAmountsProvider.notifier).toggle(),
          ),
        ],
      ),
      body: Column(
        children: [
          if (mock) const MockBanner(),
          Expanded(child: body),
        ],
      ),
      floatingActionButton: floatingActionButton,
    );
  }
}
