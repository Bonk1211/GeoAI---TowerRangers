import pandas as pd
import numpy as np
import os
from google.colab import drive
import matplotlib.pyplot as plt
from math import radians, sin, cos, sqrt, atan2

# Mount Google Drive
try:
    drive.mount('/content/drive', force_remount=True)
    print("Google Drive mounted successfully.")
except Exception as e:
    print(f"Error mounting Google Drive: {e}")
    raise SystemExit("Exiting due to Drive mount failure.")

# Define file paths
file_path = '/path/to/data.csv'
output_path = '/path/to/output.csv'
chart_dir = '/path/to/charts'

# Check if input file exists
if not os.path.exists(file_path):
    raise FileNotFoundError(f"Input file not found at: {file_path}. Please verify the path and ensure the file exists.")

# Load data
df = pd.read_csv(file_path, low_memory=False)
print(f"\n=== DATA LOAD ===")
print(f"Loaded {len(df):,} rows with {len(df.columns)} columns from processed_data_cleaned.csv")

# Preprocess: Convert only truly numeric columns to numeric, preserving others
numeric_cols = [
    'Longitude', 'Latitude', 'Speed', 'Level', 'Qual', 'SNR', 'CQI', 'LTERSSI',
    'ARFCN', 'DL_bitrate', 'UL_bitrate', 'PSC', 'Altitude', 'Accuracy', 'SERVINGTIME',
    'BANDWIDTH', 'SecondCell_RSRP', 'SecondCell_SNR', 'NRxLev1', 'NQual1',
    'PINGAVG', 'PINGMIN', 'PINGMAX', 'PINGSTDEV', 'PINGLOSS', 'Node_Longitude',
    'Node_Latitude', 'ElapsedTime'
]
for col in numeric_cols:
    if col in df.columns:
        df[col] = pd.to_numeric(df[col].replace('-', np.nan), errors='coerce')

# Calculate missingness percentages
missing_percent = df.isna().mean() * 100
print("\n=== MISSING DATA SUMMARY ===")
print(missing_percent.round(2))

# Drop columns with >50% missing values
columns_to_drop = missing_percent[missing_percent > 50].index
if len(columns_to_drop) > 0:
    print(f"\nDropping columns with >50% missing values: {list(columns_to_drop)}")
    df = df.drop(columns=columns_to_drop)
else:
    print("\nNo columns have >50% missing values.")

# Handle missing values
# Categorical columns (impute with operator-specific mode)
categorical_cols = [
    'Test_Status', 'NTech1', 'State', 'Operatorname', 'NetworkTech', 'Mobility',
    'NCellid1', 'SecondCell_NODE', 'SecondCell_CELLID', 'SecondCell_PSC',
    'SecondCell_ARFCN', 'NLAC1', 'NCell1', 'NARFCN1'
]
integer_cols = [
    'SecondCell_NODE', 'SecondCell_CELLID', 'SecondCell_PSC', 'SecondCell_ARFCN',
    'NLAC1', 'NCell1', 'NARFCN1'
]
for col in categorical_cols:
    if col in df.columns:
        missing_count = df[col].isna().sum()
        if missing_count > 0:
            df[f'{col}_missing'] = df[col].isna().astype(int)
        mode_series = df.groupby('Operatorname')[col].agg(lambda x: x.mode()[0] if not x.mode().empty else 'UNKNOWN')
        if col in integer_cols:
            mode_series = mode_series.astype(str).str.replace('.0', '', regex=False).astype(int)
        df[col] = df.apply(
            lambda row: mode_series[row['Operatorname']] if pd.isna(row[col]) else row[col],
            axis=1
        )
        if col in integer_cols:
            df[col] = df[col].astype(int)
        else:
            df[col] = df[col].astype(df[col].dtype)
        print(f"Imputed {missing_count:,} missing values in {col} with operator-specific mode:")
        for op, mode_val in mode_series.items():
            print(f"  - Operator {op}: {mode_val}")

# Numeric columns (impute with operator-specific median)
numeric_cols_to_impute = [
    'CQI', 'BANDWIDTH', 'SecondCell_RSRP', 'SecondCell_SNR', 'NRxLev1', 'NQual1',
    'SNR', 'SERVINGTIME'
]
for col in numeric_cols_to_impute:
    if col in df.columns:
        missing_count = df[col].isna().sum()
        if missing_count > 0:
            df[f'{col}_missing'] = df[col].isna().astype(int)
        original_dtype = df[col].dtype
        df[col] = df.groupby('Operatorname')[col].transform(lambda x: x.fillna(x.median()))
        overall_median = df[col].median()
        df[col] = df[col].fillna(overall_median)
        if np.issubdtype(original_dtype, np.integer) and col != 'CQI':
            df[col] = df[col].round().astype(original_dtype)
        print(f"Imputed {missing_count:,} missing values in {col} with operator-specific median.")

# Apply domain constraints for numeric columns
for col in numeric_cols_to_impute:
    if col in df.columns:
        if col == 'CQI':
            df[col] = df[col].clip(0, 15).round().astype(int)
        elif col == 'BANDWIDTH':
            df[col] = df[col].clip(1.4, 100)
        elif col == 'SecondCell_RSRP':
            df[col] = df[col].clip(-140, -44)
        elif col == 'SecondCell_SNR':
            df[col] = df[col].clip(-10, 40)
        elif col == 'NRxLev1':
            df[col] = df[col].clip(-140, -44)
        elif col == 'NQual1':
            df[col] = df[col].clip(-20, -3)

# Save final dataset
os.makedirs(os.path.dirname(output_path), exist_ok=True)
df.to_csv(output_path, index=False)
print(f"\nFinal dataset saved to: {output_path}")

# Final summary
print(f"\n=== FINAL DATA SUMMARY ===")
print(f"Total rows: {len(df):,}")
print(f"Total columns: {len(df.columns)}")
print(f"Remaining missing values:\n{df.isna().sum()}")

# --- Visualizations and Analysis ---

# Haversine function
def haversine(lon1, lat1, lon2, lat2):
    try:
        lon1, lat1, lon2, lat2 = map(float, [lon1, lat1, lon2, lat2])
        lon1, lat1, lon2, lat2 = map(radians, [lon1, lat1, lon2, lat2])
        dlon = lon2 - lon1
        dlat = lat2 - lat1
        a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
        c = 2 * atan2(sqrt(a), sqrt(1-a))
        return 6371 * c
    except (ValueError, TypeError):
        return np.nan

# Calculate coverage area
def calculate_coverage_area(df):
    if 'Latitude' not in df.columns or 'Longitude' not in df.columns:
        print("\n=== COVERAGE AREA ANALYSIS SKIPPED ===")
        print("Missing required columns: 'Latitude' or 'Longitude'")
        return {'radius_km': np.nan, 'area_km2': np.nan, 'center': (np.nan, np.nan)}
    min_lat, max_lat = df['Latitude'].min(), df['Latitude'].max()
    min_lon, max_lon = df['Longitude'].min(), df['Longitude'].max()
    center_lat = (min_lat + max_lat) / 2
    center_lon = (min_lon + max_lon) / 2
    radius_km = haversine(min_lon, min_lat, max_lon, max_lat) / 2
    area_km2 = (max_lat - min_lat) * 111 * (max_lon - min_lon) * 111 * cos(radians(center_lat))
    return {'radius_km': radius_km, 'area_km2': area_km2, 'center': (center_lat, center_lon)}

# Analyze altitude
def analyze_altitude(df, altitude_col):
    if not altitude_col or altitude_col not in df.columns:
        print("\n=== ALTITUDE ANALYSIS SKIPPED ===")
        print("No altitude data available.")
        return None
    altitude = df[altitude_col]
    metrics = {
        'Highest Point (m)': altitude.max(),
        'Lowest Point (m)': altitude.min(),
        'Mean Altitude (m)': altitude.mean(),
        'Median Altitude (m)': altitude.median(),
        'Standard Deviation (m)': altitude.std(),
        'Range (m)': altitude.max() - altitude.min()
    }
    print("\n=== ALTITUDE ANALYSIS ===")
    for metric, value in metrics.items():
        print(f"{metric}: {value:.2f}")
    return metrics

# Analyze operator
def analyze_operator(data, operator_name, area_km2):
    if 'Operatorname' not in data.columns or 'NetworkTech' not in data.columns:
        print(f"\n=== ANALYSIS: {operator_name} SKIPPED ===")
        print("Missing required columns: 'Operatorname' or 'NetworkTech'")
        return {
            'Operator': operator_name,
            'Total': 0,
            '5G': 0,
            '4G': 0,
            '5G/4G Ratio': np.nan,
            'Coverage Density': np.nan
        }
    operator_data = data[data['Operatorname'] == operator_name]
    tech_counts = operator_data['NetworkTech'].value_counts()
    total = len(operator_data)
    coverage_density = total / area_km2 if area_km2 > 0 else 0
    ratio_5g_to_4g = tech_counts.get('5G', 0) / tech_counts.get('4G', 1)
    print(f"\n=== ANALYSIS: {operator_name} ===")
    print(f"Total measurements: {total:,}")
    print(f"5G measurements: {tech_counts.get('5G', 0):,}")
    print(f"4G measurements: {tech_counts.get('4G', 0):,}")
    print(f"5G/4G ratio: {ratio_5g_to_4g:.2f}")
    print(f"Coverage density: {coverage_density:.1f} measurements/km²")
    return {
        'Operator': operator_name,
        'Total': total,
        '5G': tech_counts.get('5G', 0),
        '4G': tech_counts.get('4G', 0),
        '5G/4G Ratio': ratio_5g_to_4g,
        'Coverage Density': coverage_density
    }

# Analyze mobility
def analyze_mobility(data, speed_threshold=7):
    if 'Speed' not in data.columns or 'Operatorname' not in data.columns:
        print("\n=== MOBILITY ANALYSIS SKIPPED ===")
        print("Missing required columns: 'Speed' or 'Operatorname'")
        return {'Combined': pd.Series(), 'By Operator': {}}
    if 'Mobility' not in data.columns or data['Mobility'].isna().all():
        data['Mobility'] = np.where(data['Speed'] <= speed_threshold, 'Walking', 'Driving')
    combined = data['Mobility'].value_counts(normalize=True) * 100
    operators = {}
    for op in data['Operatorname'].unique():
        if pd.notna(op):
            op_data = data[data['Operatorname'] == op]
            operators[op] = op_data['Mobility'].value_counts(normalize=True) * 100
    return {'Combined': combined, 'By Operator': operators}

# Analyze traffic distribution
def analyze_traffic_distribution(df, chart_dir):
    required_cols = ['Operatorname', 'Test_Status', 'SessionID', 'DL_bitrate', 'UL_bitrate']
    missing_cols = [col for col in required_cols if col not in df.columns]
    if missing_cols:
        print("\n=== TRAFFIC DISTRIBUTION ANALYSIS SKIPPED ===")
        print(f"Missing required columns: {missing_cols}")
        return pd.DataFrame(), {}, {}
    print("\n=== DEBUG: UNIQUE VALUES ===")
    for col in ['State', 'Test_Status', 'BANDWIDTH', 'CQI', 'SecondCell_NODE', 'NCellid1', 'LTERSSI', 'SNR', 'SERVINGTIME']:
        if col in df.columns:
            unique_vals = df[col].unique()
            print(f"{col}: {unique_vals}")

    traffic_counts = {
        'Operatorname': [],
        'FTP Rows': [],
        'Video Streaming Rows': [],
        'HTTP Rows': [],
        'Total': []
    }
    total_dataset_rows = len(df)
    print(f"\n=== TRAFFIC DISTRIBUTION ANALYSIS ===")
    print(f"Total dataset rows: {total_dataset_rows:,}")
    video_sessions_by_operator = {}
    ftp_sessions_by_operator = {}
    for operator in df['Operatorname'].unique():
        op_data = df[df['Operatorname'] == operator].copy()
        op_rows = len(op_data)
        ftp_statuses = ['PING', 'UPLOAD', 'DOWNLOAD']
        ftp_sessions = op_data[op_data['Test_Status'].notna() & op_data['Test_Status'].str.upper().isin(ftp_statuses)]['SessionID'].unique()
        ftp_sessions_by_operator[operator] = ftp_sessions
        ftp_mask = (op_data['SessionID'].isin(ftp_sessions)) & (op_data['Test_Status'].notna() & op_data['Test_Status'].str.upper().isin(ftp_statuses))
        ftp_rows = ftp_mask.sum()
        non_ftp_data = op_data[~op_data['SessionID'].isin(ftp_sessions)]
        video_sessions = non_ftp_data[(non_ftp_data['DL_bitrate'] > 0) & (non_ftp_data['UL_bitrate'] > 0)]['SessionID'].unique()
        video_sessions_by_operator[operator] = video_sessions
        video_mask = (op_data['SessionID'].isin(video_sessions)) & ((op_data['DL_bitrate'] > 0) | (op_data['UL_bitrate'] > 0))
        video_rows = video_mask.sum()
        http_mask = ~(ftp_mask | video_mask)
        http_rows = http_mask.sum()
        overlaps = {
            'FTP & Video': (ftp_mask & video_mask).sum(),
            'FTP & HTTP': (ftp_mask & http_mask).sum(),
            'Video & HTTP': (video_mask & http_mask).sum()
        }
        total_categorized = ftp_rows + video_rows + http_rows
        print(f"\n{operator}:")
        print(f"FTP Rows: {ftp_rows:,}")
        print(f"Video Streaming Rows: {video_rows:,}")
        print(f"HTTP Rows: {http_rows:,}")
        print(f"Total Categorized Rows: {total_categorized:,}")
        print(f"Overlaps: {overlaps}")
        traffic_counts['Operatorname'].append(operator)
        traffic_counts['FTP Rows'].append(ftp_rows)
        traffic_counts['Video Streaming Rows'].append(video_rows)
        traffic_counts['HTTP Rows'].append(http_rows)
        traffic_counts['Total'].append(total_categorized)
    traffic_df = pd.DataFrame(traffic_counts)
    total_row = {
        'Operatorname': 'Total',
        'FTP Rows': traffic_df['FTP Rows'].sum(),
        'Video Streaming Rows': traffic_df['Video Streaming Rows'].sum(),
        'HTTP Rows': traffic_df['HTTP Rows'].sum(),
        'Total': traffic_df['Total'].sum()
    }
    traffic_df = pd.concat([traffic_df, pd.DataFrame([total_row])], ignore_index=True)
    traffic_df.to_csv(f'{chart_dir}/traffic_distribution.csv', index=False)
    print(f"Traffic distribution table saved to: {chart_dir}/traffic_distribution.csv")
    return traffic_df, video_sessions_by_operator, ftp_sessions_by_operator, total_row

# Plot box plots by application type
def plot_box_plots(df, video_sessions_by_operator, ftp_sessions_by_operator, chart_dir):
    required_cols = ['SessionID', 'Test_Status', 'DL_bitrate', 'UL_bitrate', 'CQI']
    missing_cols = [col for col in required_cols if col not in df.columns]
    if missing_cols:
        print("\n=== BOX PLOT ANALYSIS SKIPPED ===")
        print(f"Missing required columns: {missing_cols}")
        return
    print("\n=== DL_bitrate DISTRIBUTION (Kbps) ===")
    print(df['DL_bitrate'].describe())
    print("\n=== UL_bitrate DISTRIBUTION (Kbps) ===")
    print(df['UL_bitrate'].describe())

    app_types = ['FTP', 'Video', 'HTTP']

    # Downlink Box Plot
    plt.figure(figsize=(10, 6))
    data_down = []
    labels = []
    for app in app_types:
        if app == 'FTP':
            all_ftp_sessions = [sid for sessions in ftp_sessions_by_operator.values() for sid in sessions]
            app_data = df[df['SessionID'].isin(all_ftp_sessions) &
                         (df['Test_Status'].str.upper().isin(['PING', 'UPLOAD', 'DOWNLOAD']))]
            down_data = app_data[app_data['DL_bitrate'] > 100]['DL_bitrate'].dropna() / 1000.0
        elif app == 'Video':
            all_video_sessions = [sid for sessions in video_sessions_by_operator.values() for sid in sessions]
            app_data = df[df['SessionID'].isin(all_video_sessions)]
            down_data = app_data[app_data['DL_bitrate'] > 100]['DL_bitrate'].dropna() / 1000.0
        else:  # HTTP
            all_ftp_sessions = [sid for sessions in ftp_sessions_by_operator.values() for sid in sessions]
            all_video_sessions = [sid for sessions in video_sessions_by_operator.values() for sid in sessions]
            app_data = df[~df['SessionID'].isin(all_ftp_sessions + all_video_sessions)]
            down_data = app_data[app_data['DL_bitrate'] > 100]['DL_bitrate'].dropna() / 1000.0
        print(f"Debug: {app} DL_bitrate rows (>100 Kbps) = {len(down_data)}, "
              f"Min = {down_data.min():.2f} Mbps, Max = {down_data.max():.2f} Mbps" if len(down_data) > 0 else
              f"Debug: {app} DL_bitrate rows (>100 Kbps) = 0")
        data_down.append(down_data)
        labels.append(app)
    if any(len(d) > 0 for d in data_down):
        box = plt.boxplot(data_down, positions=range(1, len(data_down) + 1),
                         patch_artist=True, widths=0.3, showfliers=False)
        colors = ['lightblue', 'lightgreen', 'lightcoral']
        for patch, color in zip(box['boxes'], colors):
            patch.set_facecolor(color)
        plt.xticks(range(1, len(labels) + 1), labels)
        plt.xlabel('Application Type')
        plt.ylabel('Downlink Bitrate (Mbps)')
        plt.title('Distribution of Downlink Bitrates by Application Type (Values > 100 Kbps)')
        plt.grid(axis='y', alpha=0.3)
        plt.tight_layout()
        plt.savefig(f'{chart_dir}/downlink_bitrate_boxplot.png', dpi=1200)
        plt.show()
    else:
        print("No valid data for downlink box plot.")

    # Uplink Box Plot
    plt.figure(figsize=(10, 6))
    data_up = []
    labels = []
    for app in app_types:
        if app == 'FTP':
            all_ftp_sessions = [sid for sessions in ftp_sessions_by_operator.values() for sid in sessions]
            app_data = df[df['SessionID'].isin(all_ftp_sessions) &
                         (df['Test_Status'].str.upper().isin(['PING', 'UPLOAD', 'DOWNLOAD']))]
            up_data = app_data[app_data['UL_bitrate'] > 100]['UL_bitrate'].dropna() / 1000.0
        elif app == 'Video':
            all_video_sessions = [sid for sessions in video_sessions_by_operator.values() for sid in sessions]
            app_data = df[df['SessionID'].isin(all_video_sessions)]
            up_data = app_data[app_data['UL_bitrate'] > 100]['UL_bitrate'].dropna() / 1000.0
        else:  # HTTP
            all_ftp_sessions = [sid for sessions in ftp_sessions_by_operator.values() for sid in sessions]
            all_video_sessions = [sid for sessions in video_sessions_by_operator.values() for sid in sessions]
            app_data = df[~df['SessionID'].isin(all_ftp_sessions + all_video_sessions)]
            up_data = app_data[app_data['UL_bitrate'] > 100]['UL_bitrate'].dropna() / 1000.0
        print(f"Debug: {app} UL_bitrate rows (>100 Kbps) = {len(up_data)}, "
              f"Min = {up_data.min():.2f} Mbps, Max = {up_data.max():.2f} Mbps" if len(up_data) > 0 else
              f"Debug: {app} UL_bitrate rows (>100 Kbps) = 0")
        data_up.append(up_data)
        labels.append(app)
    if any(len(d) > 0 for d in data_up):
        box = plt.boxplot(data_up, positions=range(1, len(data_up) + 1),
                         patch_artist=True, widths=0.3, showfliers=False)
        colors = ['lightblue', 'lightgreen', 'lightcoral']
        for patch, color in zip(box['boxes'], colors):
            patch.set_facecolor(color)
        plt.xticks(range(1, len(labels) + 1), labels)
        plt.xlabel('Application Type')
        plt.ylabel('Uplink Bitrate (Mbps)')
        plt.title('Distribution of Uplink Bitrates by Application Type (Values > 100 Kbps)')
        plt.grid(axis='y', alpha=0.3)
        plt.tight_layout()
        plt.savefig(f'{chart_dir}/uplink_bitrate_boxplot.png', dpi=1200)
        plt.show()
    else:
        print("No valid data for uplink box plot.")

    # CQI-Based Box Plot
    plt.figure(figsize=(15, 6))
    cqi_median = df['CQI'].median()
    if pd.notna(cqi_median):
        df['CQI_imputed'] = df['CQI'].fillna(round(cqi_median))
    else:
        df['CQI_imputed'] = df['CQI'].fillna(0)
    cqi_values = sorted(df['CQI_imputed'].unique().astype(int))
    data_cqi = []
    labels_cqi = []
    for app in app_types:
        if app == 'FTP':
            all_ftp_sessions = [sid for sessions in ftp_sessions_by_operator.values() for sid in sessions]
            app_data = df[df['SessionID'].isin(all_ftp_sessions) &
                         (df['Test_Status'].str.upper().isin(['PING', 'UPLOAD', 'DOWNLOAD']))]
        elif app == 'Video':
            all_video_sessions = [sid for sessions in video_sessions_by_operator.values() for sid in sessions]
            app_data = df[df['SessionID'].isin(all_video_sessions)]
        else:  # HTTP
            all_ftp_sessions = [sid for sessions in ftp_sessions_by_operator.values() for sid in sessions]
            all_video_sessions = [sid for sessions in video_sessions_by_operator.values() for sid in sessions]
            app_data = df[~df['SessionID'].isin(all_ftp_sessions + all_video_sessions)]
        app_data_filtered = app_data[app_data['DL_bitrate'] > 100]
        print(f"Debug: {app} data rows (>100 Kbps) = {len(app_data_filtered)}, "
              f"DL_bitrate Min = {app_data_filtered['DL_bitrate'].min()/1000:.2f} Mbps, "
              f"Max = {app_data_filtered['DL_bitrate'].max()/1000:.2f} Mbps" if len(app_data_filtered) > 0 else
              f"Debug: {app} data rows (>100 Kbps) = 0")
        for cqi in cqi_values:
            cqi_data = app_data_filtered[app_data_filtered['CQI_imputed'] == cqi]['DL_bitrate'].dropna() / 1000.0
            print(f"Debug: {app} CQI {cqi} data points (>100 Kbps) = {len(cqi_data)}, "
                  f"Min = {cqi_data.min():.2f} Mbps, Max = {cqi_data.max():.2f} Mbps" if len(cqi_data) > 0 else
                  f"Debug: {app} CQI {cqi} data points = 0")
            if len(cqi_data) > 0:
                data_cqi.append(cqi_data)
                labels_cqi.append(f"{app}\nCQI {cqi}")
    if data_cqi:
        box = plt.boxplot(data_cqi, patch_artist=True, widths=0.2, showfliers=False)
        colors = ['lightblue' if 'FTP' in label else 'lightgreen' if 'Video' in label else 'lightcoral'
                  for label in labels_cqi]
        for patch, color in zip(box['boxes'], colors):
            patch.set_facecolor(color)
        plt.xticks(range(1, len(labels_cqi) + 1), labels_cqi, rotation=45)
        plt.xlabel('Application Type and CQI')
        plt.ylabel('Downlink Bitrate (Mbps)')
        plt.title('Distribution of Downlink Bitrate by Application Type and CQI (Values > 100 Kbps)')
        plt.grid(axis='y', alpha=0.3)
        plt.tight_layout()
        plt.savefig(f'{chart_dir}/cqi_bitrate_boxplot.png', dpi=1200)
        plt.show()
    else:
        print("No valid data for CQI-based box plot.")

# Perform analysis and visualizations
os.makedirs(chart_dir, exist_ok=True)
coverage = calculate_coverage_area(df)
print("\n=== COVERAGE AREA ===")
print(f"Radius: {coverage['radius_km']:.2f} km")
print(f"Area: {coverage['area_km2']:.2f} km²")
altitude_col = 'Altitude' if 'Altitude' in df.columns else None
altitude_metrics = analyze_altitude(df, altitude_col)
print("\n=== OPERATOR ANALYSIS ===")
df_op = df.drop_duplicates(subset=['Timestamp', 'Longitude', 'Latitude']) if 'Timestamp' in df.columns and 'Longitude' in df.columns and 'Latitude' in df.columns else df
print(f"df_op rows after deduplication: {len(df_op):,}")
operator_results = {}
total_measurements = 0
for operator in ['Operator A', 'Operator B', 'Operator C']:
    op_data = df_op[df_op['Operatorname'] == operator] if 'Operatorname' in df_op.columns else df_op
    operator_results[operator] = analyze_operator(op_data, operator, coverage['area_km2'])
    total_measurements += operator_results[operator]['Total']
print(f"Total measurements: {total_measurements:,}")
operator_a = operator_results['Operator A']
operator_b = operator_results['Operator B']
operator_c = operator_results['Operator C']
mobility = analyze_mobility(df)
print("\n=== MOBILITY ANALYSIS ===")
print("Combined travel modes:")
print(mobility['Combined'])
print("\nBy operator:")
for op, stats in mobility['By Operator'].items():
    print(f"\n{op}:")
    print(stats)

# Check if traffic distribution analysis can proceed
required_traffic_cols = ['Operatorname', 'Test_Status', 'SessionID', 'DL_bitrate', 'UL_bitrate']
if all(col in df.columns for col in required_traffic_cols):
    traffic_df, video_sessions_by_operator, ftp_sessions_by_operator, total_row = analyze_traffic_distribution(df, chart_dir)
    # Check if box plot analysis can proceed
    required_box_cols = ['SessionID', 'Test_Status', 'DL_bitrate', 'UL_bitrate', 'CQI']
    if all(col in df.columns for col in required_box_cols):
        plot_box_plots(df, video_sessions_by_operator, ftp_sessions_by_operator, chart_dir)
    else:
        print("\n=== BOX PLOT ANALYSIS SKIPPED ===")
        print(f"Missing required columns: {[col for col in required_box_cols if col not in df.columns]}")
else:
    print("\n=== TRAFFIC DISTRIBUTION ANALYSIS SKIPPED ===")
    print(f"Missing required columns: {[col for col in required_traffic_cols if col not in df.columns]}")
    traffic_df = pd.DataFrame()
    video_sessions_by_operator = {}
    ftp_sessions_by_operator = {}
    total_row = None

# Visualizations
plt.figure(figsize=(10, 6))
ops = ['Operator A', 'Operator B', 'Operator C']
plt.bar(ops, [operator_a['5G'], operator_b['5G'], operator_c['5G']], label='5G')
plt.bar(ops, [operator_a['4G'], operator_b['4G'], operator_c['4G']],
        bottom=[operator_a['5G'], operator_b['5G'], operator_c['5G']], label='4G')
plt.title('Network Technology Distribution by Operator')
plt.ylabel('Measurement Count')
plt.legend()
plt.grid(axis='y', alpha=0.3)
plt.tight_layout()
plt.savefig(f'{chart_dir}/tech_comparison.png', dpi=1200)
plt.show()

plt.figure(figsize=(10, 6))
penetration = [
    100 * operator_a['5G'] / operator_a['Total'] if operator_a['Total'] > 0 else 0,
    100 * operator_b['5G'] / operator_b['Total'] if operator_b['Total'] > 0 else 0,
    100 * operator_c['5G'] / operator_c['Total'] if operator_c['Total'] > 0 else 0
]
plt.bar(ops, penetration, color='green')
plt.title('5G Penetration Rate by Operator')
plt.ylabel('Percentage (%)')
plt.ylim(0, 100)
plt.grid(axis='y', alpha=0.3)
plt.tight_layout()
plt.savefig(f'{chart_dir}/5g_penetration.png', dpi=1200)
plt.show()

plt.figure(figsize=(10, 6))
density = [operator_a['Coverage Density'], operator_b['Coverage Density'], operator_c['Coverage Density']]
plt.bar(ops, density, color='purple')
plt.title('Network Coverage Density by Operator')
plt.ylabel('Measurements per km²')
plt.grid(axis='y', alpha=0.3)
plt.tight_layout()
plt.savefig(f'{chart_dir}/coverage_density.png', dpi=1200)
plt.show()

plt.figure(figsize=(8, 6))
mobility['Combined'].plot.pie(autopct='%1.1f%%', colors=['lightblue', 'orange'])
plt.title('Overall Travel Mode Distribution\n(Speed Threshold = 7 km/h)')
plt.ylabel('')
plt.tight_layout()
plt.savefig(f'{chart_dir}/mobility_combined.png', dpi=1200)
plt.show()

plt.figure(figsize=(12, 6))
for i, (op, stats) in enumerate(mobility['By Operator'].items(), 1):
    plt.subplot(1, 3, i)
    stats.plot.pie(autopct='%1.1f%%', colors=['lightblue', 'orange'])
    plt.title(op)
    plt.ylabel('')
plt.suptitle('Travel Mode Distribution by Operator\n(Speed Threshold = 7 km/h)')
plt.tight_layout()
plt.savefig(f'{chart_dir}/mobility_by_operator.png', dpi=1200)
plt.show()

plt.figure(figsize=(8, 6))
total_5g = operator_a['5G'] + operator_b['5G'] + operator_c['5G']
total_4g = operator_a['4G'] + operator_b['4G'] + operator_c['4G']
tech_counts = pd.Series({'5G': total_5g, '4G': total_4g})
print("\n=== TECHNOLOGY DISTRIBUTION ===")
print(f"5G measurements: {tech_counts['5G']:,} ({100 * tech_counts['5G'] / total_measurements:.1f}%)")
print(f"4G measurements: {tech_counts['4G']:,} ({100 * tech_counts['4G'] / total_measurements:.1f}%)")
tech_counts.plot.pie(autopct='%1.1f%%', colors=['blue', 'orange'])
plt.title('Overall Technology Distribution')
plt.ylabel('')
plt.tight_layout()
plt.savefig(f'{chart_dir}/tech_distribution.png', dpi=1200)
plt.show()

plt.figure(figsize=(10, 6))
walking = [mobility['By Operator'][op].get('Walking', 0) for op in ops]
bus = [mobility['By Operator'][op].get('Driving', 0) for op in ops]
bar_width = 0.35
index = np.arange(len(ops))
plt.bar(index, walking, bar_width, label='Walking', color='lightblue')
plt.bar(index + bar_width, bus, bar_width, label='Driving', color='orange')
plt.xlabel('Operator')
plt.ylabel('Percentage (%)')
plt.title('Travel Mode Distribution by Operator\n(Speed Threshold = 7 km/h)')
plt.xticks(index + bar_width / 2, ops)
plt.ylim(0, 100)
plt.legend()
plt.grid(axis='y', alpha=0.3)
plt.tight_layout()
plt.savefig(f'{chart_dir}/mobility_bar_all_operators.png', dpi=1200)
plt.show()

if altitude_col:
    plt.figure(figsize=(10, 6))
    plt.hist(df[altitude_col], bins=30, color='teal', edgecolor='black')
    plt.title('Altitude Distribution of Measurements')
    plt.xlabel('Altitude (meters)')
    plt.ylabel('Frequency')
    plt.grid(axis='y', alpha=0.3)
    plt.tight_layout()
    plt.savefig(f'{chart_dir}/altitude_distribution.png', dpi=1200)
    plt.show()

# Traffic distribution visualizations (only if traffic analysis was performed)
if not traffic_df.empty and total_row is not None:
    plt.figure(figsize=(10, 6))
    operators = traffic_df['Operatorname'][:-1]
    ftp_counts = traffic_df['FTP Rows'][:-1]
    video_counts = traffic_df['Video Streaming Rows'][:-1]
    http_counts = traffic_df['HTTP Rows'][:-1]
    bar_width = 0.25
    index = np.arange(len(operators))
    plt.bar(index, ftp_counts, bar_width, label='FTP', color='blue')
    plt.bar(index + bar_width, video_counts, bar_width, label='Video Streaming', color='green')
    plt.bar(index + 2 * bar_width, http_counts, bar_width, label='HTTP', color='orange')
    plt.xlabel('Operator')
    plt.ylabel('Number of Records')
    plt.title('Traffic Distribution by Operator')
    plt.xticks(index + bar_width, operators)
    plt.legend()
    plt.grid(axis='y', alpha=0.3)
    plt.tight_layout()
    plt.savefig(f'{chart_dir}/traffic_distribution.png', dpi=1200)
    plt.show()

    plt.figure(figsize=(8, 6))
    total_counts = [total_row['FTP Rows'], total_row['Video Streaming Rows'], total_row['HTTP Rows']]
    labels = ['FTP', 'Video Streaming', 'HTTP']
    colors = ['blue', 'green', 'orange']
    percentages = []
    def custom_autopct(values):
        def my_autopct(pct):
            percentages.append(pct)
            return f'{round(pct)}%'
        return my_autopct
    plt.pie(total_counts, labels=labels, colors=colors, autopct=custom_autopct(total_counts))
    rounded_percentages = [round(p) for p in percentages]
    current_sum = sum(rounded_percentages)
    if current_sum != 100:
        max_idx = np.argmax(percentages)
        rounded_percentages[max_idx] += 100 - current_sum
    plt.title('Overall Traffic Distribution Across All Operators')
    plt.tight_layout()
    plt.savefig(f'{chart_dir}/traffic_distribution_pie.png', dpi=1200)
    plt.show()

print(f"\nAnalysis complete. Charts saved to: {chart_dir}")