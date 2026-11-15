import Foundation

struct BoardTodo: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var text: String
    var done: Bool = false
    var day: String? = nil

    static func dayKey(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// Carry the same unfinished item to today, including days spent with the
    /// app closed. Finished history and explicitly scheduled future work stay put.
    static func rollingOver(_ items: [BoardTodo], now: Date = Date(), calendar: Calendar = .current) -> [BoardTodo] {
        let today = dayKey(now, calendar: calendar)
        return items.map { original in
            var item = original
            if item.day == nil {
                item.day = today // Compatibility with undated saved items.
            } else if !item.done, let day = item.day, day < today, validDay(day, calendar: calendar) {
                item.day = today
            }
            return item
        }
    }

    private static func validDay(_ value: String, calendar: Calendar) -> Bool {
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              let date = calendar.date(from: DateComponents(year: year, month: month, day: day)) else { return false }
        return dayKey(date, calendar: calendar) == value
    }
}
