import Foundation

@main struct TodoRolloverChecks {
    static func main() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 12) -> Date {
            calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
        }
        let yesterday = BoardTodo(id: "pending", text: "Pending", day: "2026-10-14")
        let done = BoardTodo(id: "done", text: "Finished", done: true, day: "2026-10-14")
        let future = BoardTodo(id: "future", text: "Scheduled", day: "2026-10-17")
        let overdue = BoardTodo(id: "overdue", text: "Pending", day: "2026-10-01")
        let today = BoardTodo(id: "today", text: "Today", day: "2026-10-15")
        let input = [yesterday, done, future, overdue, today]
        let rolled = BoardTodo.rollingOver(input, now: date(2026, 10, 15), calendar: calendar)
        precondition(rolled.map(\.id) == input.map(\.id))
        precondition(rolled.map(\.text) == input.map(\.text))
        precondition(rolled[0].day == "2026-10-15" && rolled[3].day == "2026-10-15")
        precondition(rolled[1] == done && rolled[2] == future && rolled[4] == today)
        precondition(BoardTodo.rollingOver(rolled, now: date(2026, 10, 15), calendar: calendar) == rolled)
        // Same text on distinct original items is intentional; neither is lost.
        precondition(rolled.filter { $0.text == "Pending" }.count == 2)
        var completed = rolled
        completed[0].done = true
        let tomorrow = BoardTodo.rollingOver(completed, now: date(2026, 10, 16), calendar: calendar)
        precondition(tomorrow[0] == completed[0] && tomorrow[3].day == "2026-10-16")
        let legacy = try JSONDecoder().decode([BoardTodo].self, from: Data("[{\"id\":\"legacy\",\"text\":\"Old item\",\"done\":false}]".utf8))
        precondition(BoardTodo.rollingOver(legacy, now: date(2026, 10, 15), calendar: calendar)[0].day == "2026-10-15")
        let restored = try JSONDecoder().decode([BoardTodo].self, from: JSONEncoder().encode(rolled))
        precondition(restored == rolled)
        let invalid = [BoardTodo(text: "Invalid", day: "2026-02-30"), BoardTodo(text: "Unknown", day: "invalid")]
        precondition(BoardTodo.rollingOver(invalid, now: date(2026, 10, 15), calendar: calendar) == invalid)
        let newYear = BoardTodo.rollingOver([BoardTodo(text: "Year end", day: "2026-12-31")], now: date(2027, 1, 1, 0), calendar: calendar)
        precondition(newYear[0].day == "2027-01-01")
        // Spring DST has a 23-hour day; use local calendar dates, not 24h math.
        let dst = BoardTodo.rollingOver([BoardTodo(text: "DST", day: "2026-03-08")], now: date(2026, 3, 9, 0), calendar: calendar)
        precondition(dst[0].day == "2026-03-09")
        let midnight = date(2026, 10, 15, 0)
        precondition(BoardTodo.rollingOver([yesterday], now: midnight.addingTimeInterval(-1), calendar: calendar)[0] == yesterday)
        precondition(BoardTodo.rollingOver([yesterday], now: midnight, calendar: calendar)[0].day == "2026-10-15")
        print("PASS: todo rollover, completed history, future scheduling, repeat loads, legacy storage, restart gaps, midnight and DST")
    }
}
