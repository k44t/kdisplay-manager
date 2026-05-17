#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <math.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define MAX_SLOTS 64

static volatile sig_atomic_t keep_running = 1;
static int source_fd = -1;
static int uinput_fd = -1;

struct axis_info {
	bool present;
	struct input_absinfo abs;
};

struct point_state {
	bool has_x;
	bool has_y;
	int32_t x;
	int32_t y;
};

struct mapper_options {
	const char *device_path;
	const char *virtual_name;
	double matrix[6];
	bool grab_device;
};

static struct axis_info single_x_axis = {0};
static struct axis_info single_y_axis = {0};
static struct axis_info mt_x_axis = {0};
static struct axis_info mt_y_axis = {0};
static struct point_state single_point = {0};
static struct point_state mt_points[MAX_SLOTS] = {0};
static int current_slot = 0;

static void handle_signal(int signo) {
	(void)signo;
	keep_running = 0;
}

static void cleanup(void) {
	if (source_fd >= 0) {
		ioctl(source_fd, EVIOCGRAB, 0);
		close(source_fd);
		source_fd = -1;
	}
	if (uinput_fd >= 0) {
		ioctl(uinput_fd, UI_DEV_DESTROY);
		close(uinput_fd);
		uinput_fd = -1;
	}
}

static void fail(const char *message) {
	perror(message);
	cleanup();
	exit(1);
}

static bool test_bit(const unsigned long *bits, int bit) {
	return (bits[bit / (8 * (int)sizeof(unsigned long))] >> (bit % (8 * (int)sizeof(unsigned long)))) & 1UL;
}

static double clamp01(double value) {
	if (value < 0.0)
		return 0.0;
	if (value > 1.0)
		return 1.0;
	return value;
}

static double normalize_axis_value(const struct axis_info *axis, int32_t value) {
	double range = (double)axis->abs.maximum - (double)axis->abs.minimum;
	if (range <= 0.0)
		return 0.0;
	return ((double)value - (double)axis->abs.minimum) / range;
}

static int32_t denormalize_axis_value(const struct axis_info *axis, double value) {
	double range = (double)axis->abs.maximum - (double)axis->abs.minimum;
	double scaled = (double)axis->abs.minimum + clamp01(value) * range;
	if (scaled < (double)axis->abs.minimum)
		scaled = (double)axis->abs.minimum;
	if (scaled > (double)axis->abs.maximum)
		scaled = (double)axis->abs.maximum;
	return (int32_t)llround(scaled);
}

static void apply_matrix(const double matrix[6], double x, double y, double *out_x, double *out_y) {
	*out_x = matrix[0] * x + matrix[1] * y + matrix[2];
	*out_y = matrix[3] * x + matrix[4] * y + matrix[5];
}

static void emit_event(uint16_t type, uint16_t code, int32_t value) {
	struct input_event ev;
	memset(&ev, 0, sizeof(ev));
	ev.type = type;
	ev.code = code;
	ev.value = value;
	if (write(uinput_fd, &ev, sizeof(ev)) != (ssize_t)sizeof(ev))
		fail("write uinput event");
}

static void forward_event(const struct input_event *ev) {
	if (write(uinput_fd, ev, sizeof(*ev)) != (ssize_t)sizeof(*ev))
		fail("forward event");
}

static void emit_transformed_pair(const struct mapper_options *options,
		const struct axis_info *x_axis,
		const struct axis_info *y_axis,
		struct point_state *point,
		uint16_t x_code,
		uint16_t y_code) {
	if (!x_axis->present || !y_axis->present || !point->has_x || !point->has_y)
		return;

	double x = normalize_axis_value(x_axis, point->x);
	double y = normalize_axis_value(y_axis, point->y);
	double out_x;
	double out_y;
	apply_matrix(options->matrix, x, y, &out_x, &out_y);
	emit_event(EV_ABS, x_code, denormalize_axis_value(x_axis, out_x));
	emit_event(EV_ABS, y_code, denormalize_axis_value(y_axis, out_y));
}

static void parse_matrix(const char *source, double matrix[6]) {
	char *copy = strdup(source);
	char *cursor = copy;
	char *end = NULL;
	for (int i = 0; i < 6; ++i) {
		if (cursor == NULL) {
			fprintf(stderr, "invalid matrix\n");
			exit(1);
		}
		errno = 0;
		matrix[i] = strtod(cursor, &end);
		if (errno != 0 || end == cursor) {
			fprintf(stderr, "invalid matrix\n");
			free(copy);
			exit(1);
		}
		cursor = end;
	}
	free(copy);
}

static void parse_args(int argc, char **argv, struct mapper_options *options) {
	memset(options, 0, sizeof(*options));
	options->grab_device = true;
	options->virtual_name = "kdisplay-manager Touch Mapper";
	for (int i = 1; i < argc; ++i) {
		if (strcmp(argv[i], "--device") == 0 && i + 1 < argc) {
			options->device_path = argv[++i];
			continue;
		}
		if (strcmp(argv[i], "--matrix") == 0 && i + 1 < argc) {
			parse_matrix(argv[++i], options->matrix);
			continue;
		}
		if (strcmp(argv[i], "--name") == 0 && i + 1 < argc) {
			options->virtual_name = argv[++i];
			continue;
		}
		if (strcmp(argv[i], "--no-grab") == 0) {
			options->grab_device = false;
			continue;
		}
		fprintf(stderr, "unknown argument: %s\n", argv[i]);
		exit(1);
	}

	if (options->device_path == NULL) {
		fprintf(stderr, "missing --device\n");
		exit(1);
	}
}

static void copy_event_bits(int type, unsigned long *bits, int max_code, unsigned long request) {
	memset(bits, 0, ((size_t)max_code / (8 * sizeof(unsigned long)) + 2) * sizeof(unsigned long));
	if (ioctl(source_fd, request, bits) < 0)
		fail("ioctl EVIOCGBIT");
	for (int code = 0; code <= max_code; ++code) {
		if (!test_bit(bits, code))
			continue;
		int result = 0;
		switch (type) {
		case EV_KEY:
			result = ioctl(uinput_fd, UI_SET_KEYBIT, code);
			break;
		case EV_ABS:
			result = ioctl(uinput_fd, UI_SET_ABSBIT, code);
			break;
		case EV_MSC:
			result = ioctl(uinput_fd, UI_SET_MSCBIT, code);
			break;
		case EV_SW:
			result = ioctl(uinput_fd, UI_SET_SWBIT, code);
			break;
		default:
			break;
		}
		if (result < 0)
			fail("ioctl UI_SET_*BIT");
	}
}

static void setup_axis_info(int code, struct axis_info *axis) {
	memset(axis, 0, sizeof(*axis));
	if (ioctl(source_fd, EVIOCGABS(code), &axis->abs) == 0)
		axis->present = true;
}

static void setup_virtual_device(const struct mapper_options *options) {
	unsigned long ev_bits[(EV_MAX / (8 * sizeof(unsigned long))) + 2];
	unsigned long key_bits[(KEY_MAX / (8 * sizeof(unsigned long))) + 2];
	unsigned long abs_bits[(ABS_MAX / (8 * sizeof(unsigned long))) + 2];
	unsigned long msc_bits[(MSC_MAX / (8 * sizeof(unsigned long))) + 2];
	unsigned long sw_bits[(SW_MAX / (8 * sizeof(unsigned long))) + 2];
	struct input_id input_id;
	struct uinput_user_dev user_dev;

	uinput_fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
	if (uinput_fd < 0)
		fail("open /dev/uinput");

	memset(ev_bits, 0, sizeof(ev_bits));
	if (ioctl(source_fd, EVIOCGBIT(0, sizeof(ev_bits)), ev_bits) < 0)
		fail("ioctl EVIOCGBIT(0)");

	for (int type = 0; type <= EV_MAX; ++type) {
		if (!test_bit(ev_bits, type))
			continue;
		if (type == EV_FF || type == EV_REP || type == EV_LED || type == EV_SND)
			continue;
		if (ioctl(uinput_fd, UI_SET_EVBIT, type) < 0)
			fail("ioctl UI_SET_EVBIT");
	}

	if (test_bit(ev_bits, EV_KEY))
		copy_event_bits(EV_KEY, key_bits, KEY_MAX, EVIOCGBIT(EV_KEY, sizeof(key_bits)));
	if (test_bit(ev_bits, EV_ABS))
		copy_event_bits(EV_ABS, abs_bits, ABS_MAX, EVIOCGBIT(EV_ABS, sizeof(abs_bits)));
	if (test_bit(ev_bits, EV_MSC))
		copy_event_bits(EV_MSC, msc_bits, MSC_MAX, EVIOCGBIT(EV_MSC, sizeof(msc_bits)));
	if (test_bit(ev_bits, EV_SW))
		copy_event_bits(EV_SW, sw_bits, SW_MAX, EVIOCGBIT(EV_SW, sizeof(sw_bits)));

	setup_axis_info(ABS_X, &single_x_axis);
	setup_axis_info(ABS_Y, &single_y_axis);
	setup_axis_info(ABS_MT_POSITION_X, &mt_x_axis);
	setup_axis_info(ABS_MT_POSITION_Y, &mt_y_axis);

	memset(&input_id, 0, sizeof(input_id));
	if (ioctl(source_fd, EVIOCGID, &input_id) < 0)
		fail("ioctl EVIOCGID");

	memset(&user_dev, 0, sizeof(user_dev));
	strncpy(user_dev.name, options->virtual_name, UINPUT_MAX_NAME_SIZE - 1);
	user_dev.id = input_id;

	for (int code = 0; code <= ABS_MAX; ++code) {
		struct input_absinfo abs;
		if (ioctl(source_fd, EVIOCGABS(code), &abs) == 0) {
			user_dev.absmin[code] = abs.minimum;
			user_dev.absmax[code] = abs.maximum;
			user_dev.absfuzz[code] = abs.fuzz;
			user_dev.absflat[code] = abs.flat;
		}
	}

	if (write(uinput_fd, &user_dev, sizeof(user_dev)) != (ssize_t)sizeof(user_dev))
		fail("write uinput_user_dev");
	if (ioctl(uinput_fd, UI_DEV_CREATE) < 0)
		fail("ioctl UI_DEV_CREATE");
}

static void open_source_device(const struct mapper_options *options) {
	source_fd = open(options->device_path, O_RDONLY);
	if (source_fd < 0)
		fail("open source device");
	if (options->grab_device && ioctl(source_fd, EVIOCGRAB, 1) < 0)
		fail("ioctl EVIOCGRAB");
}

static void run_loop(const struct mapper_options *options) {
	struct input_event ev;
	while (keep_running) {
		ssize_t count = read(source_fd, &ev, sizeof(ev));
		if (count == 0)
			break;
		if (count < 0) {
			if (errno == EINTR)
				continue;
			fail("read source device");
		}
		if (count != (ssize_t)sizeof(ev))
			continue;

		if (ev.type == EV_ABS && ev.code == ABS_MT_SLOT) {
			current_slot = ev.value;
			if (current_slot < 0)
				current_slot = 0;
			if (current_slot >= MAX_SLOTS)
				current_slot = MAX_SLOTS - 1;
			forward_event(&ev);
			continue;
		}

		if (ev.type == EV_ABS && ev.code == ABS_X) {
			single_point.x = ev.value;
			single_point.has_x = true;
			emit_transformed_pair(options, &single_x_axis, &single_y_axis, &single_point, ABS_X, ABS_Y);
			continue;
		}

		if (ev.type == EV_ABS && ev.code == ABS_Y) {
			single_point.y = ev.value;
			single_point.has_y = true;
			emit_transformed_pair(options, &single_x_axis, &single_y_axis, &single_point, ABS_X, ABS_Y);
			continue;
		}

		if (ev.type == EV_ABS && ev.code == ABS_MT_POSITION_X) {
			mt_points[current_slot].x = ev.value;
			mt_points[current_slot].has_x = true;
			emit_transformed_pair(options, &mt_x_axis, &mt_y_axis, &mt_points[current_slot], ABS_MT_POSITION_X, ABS_MT_POSITION_Y);
			continue;
		}

		if (ev.type == EV_ABS && ev.code == ABS_MT_POSITION_Y) {
			mt_points[current_slot].y = ev.value;
			mt_points[current_slot].has_y = true;
			emit_transformed_pair(options, &mt_x_axis, &mt_y_axis, &mt_points[current_slot], ABS_MT_POSITION_X, ABS_MT_POSITION_Y);
			continue;
		}

		forward_event(&ev);
	}
}

int main(int argc, char **argv) {
	struct mapper_options options;
	parse_args(argc, argv, &options);
	signal(SIGINT, handle_signal);
	signal(SIGTERM, handle_signal);
	open_source_device(&options);
	setup_virtual_device(&options);
	run_loop(&options);
	cleanup();
	return 0;
}
