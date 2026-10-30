"""Activate the real GTK file chooser using the system Python's AT-SPI bindings."""

import sys
import time


def walk(accessible):
    yield accessible
    for index in range(accessible.get_child_count()):
        child = accessible.get_child_at_index(index)
        if child is not None:
            yield from walk(child)


def find_open_button(desktop, pid, title, button_role):
    for index in range(desktop.get_child_count()):
        application = desktop.get_child_at_index(index)
        if application is None or application.get_process_id() != pid:
            continue
        for dialog in walk(application):
            if dialog.get_name() == title:
                return next((node for node in walk(dialog) if node.get_role() == button_role and node.get_name() == "Open"), None)
    return None


def main(pid, title):
    # setup-python's interpreter cannot import Ubuntu's python3-gi package.
    # This helper is deliberately launched with /usr/bin/python3 instead.
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi

    Atspi.init()
    Atspi.set_timeout(1000, 2000)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        button = find_open_button(Atspi.get_desktop(0), pid, title, Atspi.Role.PUSH_BUTTON)
        if button is not None:
            states = button.get_state_set()
            if states.contains(Atspi.StateType.SHOWING) and states.contains(Atspi.StateType.SENSITIVE):
                assert button.get_action_iface().do_action(0), "GTK Open action failed"
                return
        time.sleep(0.05)
    raise AssertionError(f"GTK Open button unavailable: pid={pid}, dialog={title}")


if __name__ == "__main__":
    main(int(sys.argv[1]), sys.argv[2])
