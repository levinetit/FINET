import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/finance/providers.dart';
import '../money/format.dart';

/// Selectorul de lună (săgeți stânga/dreapta), comun Acasă, Bugetelor și Rapoartelor. Luna e
/// aceeași pe toate ecranele; API-ul acceptă luna curentă și 60 de luni în urmă.
class MonthSelector extends ConsumerWidget {
  const MonthSelector({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final month = ref.watch(selectedMonthProvider);
    final controller = ref.read(selectedMonthProvider.notifier);
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        IconButton(
          tooltip: 'Luna anterioară',
          icon: const Icon(Icons.chevron_left),
          onPressed: controller.canGoPrevious ? controller.previous : null,
        ),
        Semantics(
          liveRegion: true,
          child: Text(
            formatMonth(month.firstDay),
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ),
        IconButton(
          tooltip: 'Luna următoare',
          icon: const Icon(Icons.chevron_right),
          onPressed: controller.canGoNext ? controller.next : null,
        ),
      ],
    );
  }
}
